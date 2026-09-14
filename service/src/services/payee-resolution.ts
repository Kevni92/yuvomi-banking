import type { DatabaseSync } from 'node:sqlite';
import type { EncryptionService } from '../security/encryption.js';
import { readStoredProviderPayload } from './provider-transaction-payload.js';
import { deriveTransactionSemantics } from './transaction-semantics.js';
import { isPaymentProcessor, isTechnicalPaymentParty } from './payment-intermediaries.js';
import {
  counterpartyIdentifierHash,
  extractPayeeIdentifiers,
  hashPayeeIdentifier,
  type PayeeIdentifierEvidence,
  type PayeeIdentifierStrength,
  type PayeeIdentifierType
} from './payee-identifiers.js';

interface PayeeTransactionRow {
  id: number;
  account_id: number;
  yuvomi_user_id: number;
  direction: 'incoming' | 'outgoing';
  status: 'BOOK' | 'PDNG' | 'UNKNOWN';
  counterparty_id: string | null;
  counterparty_name: string | null;
  merchant_name: string | null;
  merchant_key: string | null;
  counterparty_additional_identification: string | null;
  bank_transaction_code: string | null;
  raw_payload_encrypted: string | null;
}

interface ResolutionRow {
  entity_type: 'merchant' | 'own_transfer' | 'counterparty';
  display_name: string;
  merchant_key: string | null;
}

interface ObservationRow {
  status: 'PDNG' | 'BOOK' | 'UNKNOWN';
  counterparty_name: string | null;
  purpose: string | null;
  provider_merchant_name: string | null;
  bank_transaction_code: string | null;
}

interface StoredEvidence extends PayeeIdentifierEvidence {
  identifierHash: string;
}

export interface PayeeResolutionResult {
  considered: number;
  matched: number;
  created: number;
  confirmed: number;
  candidates: number;
  ambiguous: number;
  excluded: number;
}

export function resolvePayeesForAccount({
  database,
  accountId,
  encryption,
  hmacSecret,
  now = new Date(),
  manageTransaction = true,
  dryRun = false
}: {
  database: DatabaseSync;
  accountId: number;
  encryption: EncryptionService;
  hmacSecret: string;
  now?: Date;
  manageTransaction?: boolean;
  dryRun?: boolean;
}): PayeeResolutionResult {
  validateInput(accountId, hmacSecret, now);
  const transactions = database.prepare(`
    SELECT transactions.id, transactions.account_id,
           enable_banking_connections.yuvomi_user_id,
           transactions.direction, transactions.status,
           counterparties.counterparty_id,
           transactions.counterparty_name, transactions.merchant_name,
           transactions.merchant_key, transactions.counterparty_additional_identification,
           transactions.bank_transaction_code, transactions.raw_payload_encrypted
    FROM transactions
    JOIN bank_accounts ON bank_accounts.id = transactions.account_id
    JOIN enable_banking_connections
      ON enable_banking_connections.id = bank_accounts.connection_id
    LEFT JOIN counterparties ON counterparties.id = transactions.counterparty_ref
    WHERE transactions.account_id = ?
    ORDER BY transactions.id
  `).all(accountId) as unknown as PayeeTransactionRow[];
  const empty: PayeeResolutionResult = {
    considered: 0, matched: 0, created: 0, confirmed: 0,
    candidates: 0, ambiguous: 0, excluded: 0
  };
  if (!transactions.length) return empty;

  const observations = database.prepare(`
    SELECT transaction_observations.transaction_id, transaction_observations.status,
           transaction_observations.counterparty_name, transaction_observations.purpose,
           transaction_observations.provider_merchant_name,
           transaction_observations.bank_transaction_code
    FROM transaction_observations
    WHERE transaction_observations.transaction_id IN (
      SELECT id FROM transactions WHERE account_id = ?
    )
    ORDER BY transaction_observations.observed_at DESC, transaction_observations.id DESC
  `).all(accountId) as unknown as Array<ObservationRow & { transaction_id: number }>;
  const observationsByTransaction = new Map<number, ObservationRow[]>();
  for (const observation of observations) {
    const rows = observationsByTransaction.get(Number(observation.transaction_id)) ?? [];
    rows.push(observation);
    observationsByTransaction.set(Number(observation.transaction_id), rows);
  }

  const timestamp = now.toISOString();
  const result: PayeeResolutionResult = { ...empty, considered: transactions.length };
  const resolutionStatement = database.prepare(`
    SELECT entity_type, display_name, merchant_key
    FROM transaction_resolutions WHERE transaction_id = ?
  `);
  const evidenceInsert = database.prepare(`
    INSERT OR IGNORE INTO transaction_payee_evidence (
      transaction_id, identifier_type, identifier_hash, strength, source, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const identifierLookup = database.prepare(`
    SELECT payee_id FROM payee_identifiers
    WHERE yuvomi_user_id = ? AND identifier_type = ? AND identifier_hash = ?
  `);
  const createPayee = database.prepare(`
    INSERT INTO payees (
      yuvomi_user_id, display_name, display_name_source, status,
      confirmed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const identifierInsert = database.prepare(`
    INSERT INTO payee_identifiers (
      payee_id, yuvomi_user_id, identifier_type, identifier_hash,
      strength, source, created_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(yuvomi_user_id, identifier_type, identifier_hash) DO UPDATE SET
      strength = CASE WHEN excluded.strength = 'strong' THEN 'strong' ELSE payee_identifiers.strength END,
      last_seen_at = excluded.last_seen_at
  `);
  const evidenceByTransaction = database.prepare(`
    SELECT identifier_type, identifier_hash, strength, source
    FROM transaction_payee_evidence WHERE transaction_id = ?
  `);
  const updateTransaction = database.prepare(`
    UPDATE transactions SET payee_id = ?, payee_match_state = ?,
      payee_match_method = ?, payee_match_confidence = ?, updated_at = ?
    WHERE id = ?
  `);
  const updatePayee = database.prepare(`
    UPDATE payees SET display_name = ?, display_name_source = ?, updated_at = ?
    WHERE id = ? AND ? > CASE display_name_source
      WHEN 'provider.counterparty_name' THEN 10
      WHEN 'resolution.merchant_name' THEN 50
      WHEN 'resolution.merchant_key' THEN 70
      WHEN 'provider.creditor_account.iban' THEN 80
      WHEN 'provider.sepa_creditor_id' THEN 90
      ELSE 0 END
  `);
  const promotePayee = database.prepare(`
    UPDATE payees SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, ?), updated_at = ?
    WHERE id = ? AND status = 'candidate'
  `);

  const openTransaction = manageTransaction;
  if (openTransaction) database.exec('BEGIN IMMEDIATE;');
  try {
    for (const transaction of transactions) {
      const resolution = resolutionStatement.get(transaction.id) as ResolutionRow | undefined;
      const semantics = resolveSemantics(transaction, observationsByTransaction.get(transaction.id) ?? []);
      if (shouldExclude(transaction, resolution, semantics)) {
        updateTransaction.run(null, 'excluded', exclusionMethod(transaction, resolution, semantics), 1, timestamp, transaction.id);
        result.excluded += 1;
        continue;
      }

      const identifiers = collectEvidence(transaction, resolution, observationsByTransaction.get(transaction.id) ?? [], encryption, semantics.paymentMethod);
      const storedEvidence = identifiers.map((identifier) => ({
        ...identifier,
        identifierHash: identifier.identifierType === 'counterparty_iban' && identifier.normalizedValue.startsWith('legacy:')
          ? counterpartyIdentifierHash(identifier.normalizedValue.slice('legacy:'.length))
          : hashPayeeIdentifier(identifier.identifierType, identifier.normalizedValue, hmacSecret)
      }));
      for (const identifier of storedEvidence) {
        evidenceInsert.run(
          transaction.id, identifier.identifierType, identifier.identifierHash,
          identifier.strength, identifier.source, timestamp
        );
      }
      if (!storedEvidence.length) {
        updateTransaction.run(null, 'unresolved', null, null, timestamp, transaction.id);
        continue;
      }

      const matchedPayeeIds = new Set<number>();
      for (const identifier of storedEvidence) {
        const matches = identifierLookup.all(
          transaction.yuvomi_user_id, identifier.identifierType, identifier.identifierHash
        ) as Array<{ payee_id: number }>;
        for (const match of matches) matchedPayeeIds.add(Number(match.payee_id));
      }
      if (matchedPayeeIds.size > 1) {
        updateTransaction.run(null, 'ambiguous', 'conflicting_identifiers', 0, timestamp, transaction.id);
        result.ambiguous += 1;
        continue;
      }

      const strongEvidence = storedEvidence.some((item) => item.strength === 'strong');
      let payeeId = [...matchedPayeeIds][0] ?? null;
      let created = false;
      if (payeeId === null) {
        const display = chooseDisplayName(storedEvidence);
        const status = strongEvidence ? 'confirmed' : 'candidate';
        const inserted = createPayee.run(
          transaction.yuvomi_user_id, display.name, display.source, status,
          status === 'confirmed' ? timestamp : null, timestamp, timestamp
        );
        payeeId = Number(inserted.lastInsertRowid);
        created = true;
        result.created += 1;
        if (status === 'confirmed') result.confirmed += 1;
        else result.candidates += 1;
      }

      const existingEvidence = evidenceByTransaction.all(transaction.id) as Array<{
        identifier_type: PayeeIdentifierType;
        identifier_hash: string;
        strength: PayeeIdentifierStrength | 'context';
        source: string;
      }>;
      const hasConfirmedStrongOnTransaction = existingEvidence.some((item) => item.strength === 'strong');
      for (const identifier of storedEvidence) {
        const existing = identifierLookup.get(
          transaction.yuvomi_user_id, identifier.identifierType, identifier.identifierHash
        ) as { payee_id: number } | undefined;
        if (existing && Number(existing.payee_id) !== payeeId) continue;
        identifierInsert.run(
          payeeId, transaction.yuvomi_user_id, identifier.identifierType,
          identifier.identifierHash, identifier.strength, identifier.source,
          timestamp, timestamp
        );
      }

      const display = chooseDisplayName(storedEvidence);
      updatePayee.run(display.name, display.source, timestamp, payeeId, display.rank);
      const payee = database.prepare('SELECT status FROM payees WHERE id = ?').get(payeeId) as { status: string } | undefined;
      if (payee?.status === 'candidate' && (strongEvidence || hasConfirmedStrongOnTransaction)) {
        const changed = promotePayee.run(timestamp, timestamp, payeeId);
        if (Number(changed.changes)) result.confirmed += 1;
      }

      const method = strongEvidence
        ? storedEvidence.find((item) => item.strength === 'strong')?.identifierType ?? 'strong'
        : 'candidate_name';
      const confidence = strongEvidence ? 1 : 0.65;
      updateTransaction.run(payeeId, 'matched', method, confidence, timestamp, transaction.id);
      if (!created) result.matched += 1;
    }
    if (dryRun && openTransaction) {
      database.exec('ROLLBACK;');
    } else if (!dryRun && openTransaction) {
      database.exec('COMMIT;');
    }
  } catch (error) {
    if (openTransaction) {
      try { database.exec('ROLLBACK;'); } catch { /* preserve original error */ }
    }
    throw error;
  }
  return result;
}

export function resolvePayeeForTransaction({
  database,
  transactionId,
  encryption,
  hmacSecret,
  now = new Date()
}: {
  database: DatabaseSync;
  transactionId: number;
  encryption: EncryptionService;
  hmacSecret: string;
  now?: Date;
}): PayeeResolutionResult {
  const row = database.prepare('SELECT account_id FROM transactions WHERE id = ? LIMIT 1').get(transactionId) as { account_id: number } | undefined;
  if (!row) return { considered: 0, matched: 0, created: 0, confirmed: 0, candidates: 0, ambiguous: 0, excluded: 0 };
  return resolvePayeesForAccount({ database, accountId: Number(row.account_id), encryption, hmacSecret, now });
}

function collectEvidence(
  transaction: PayeeTransactionRow,
  resolution: ResolutionRow | undefined,
  observations: ObservationRow[],
  encryption: EncryptionService,
  paymentMethod: string | null
): PayeeIdentifierEvidence[] {
  const records: Array<Record<string, unknown>> = [];
  const payload = readStoredProviderPayload(transaction.raw_payload_encrypted, encryption);
  if (payload?.list) records.push(payload.list);
  if (payload?.detail) records.push(payload.detail);
  if (transaction.counterparty_additional_identification) {
    const [scheme_name, identification] = transaction.counterparty_additional_identification.split(':', 2);
    records.push({ creditor_account_additional_identification: { scheme_name, identification } });
  }
  // Observations preserve names and remittance text but deliberately do not
  // recreate provider identifiers that were never stored in the encrypted payload.
  records.push(...observations.map((observation) => ({
    counterparty_name: observation.counterparty_name,
    remittance_information: observation.purpose,
    bank_transaction_code: observation.bank_transaction_code,
    merchant_name: observation.provider_merchant_name
  })));
  return extractPayeeIdentifiers({
    counterpartyId: transaction.counterparty_id,
    counterpartyName: transaction.counterparty_name,
    merchantName: transaction.merchant_name,
    merchantKey: resolution?.merchant_key ?? transaction.merchant_key,
    paymentMethod,
    resolutionEntityType: resolution?.entity_type ?? null,
    resolutionDisplayName: resolution?.entity_type === 'merchant' ? resolution.display_name : null,
    providerRecords: records
  });
}

function resolveSemantics(transaction: PayeeTransactionRow, observations: ObservationRow[]): {
  kind: ReturnType<typeof deriveTransactionSemantics>['kind'];
  paymentMethod: string | null;
} {
  const values = [transaction.bank_transaction_code, ...observations.map((item) => item.bank_transaction_code)];
  for (const value of values) {
    const semantics = deriveTransactionSemantics(value);
    if (semantics.kind || semantics.paymentMethod) return { kind: semantics.kind, paymentMethod: semantics.paymentMethod };
  }
  return { kind: null, paymentMethod: null };
}

function shouldExclude(
  transaction: PayeeTransactionRow,
  resolution: ResolutionRow | undefined,
  semantics: { kind: ReturnType<typeof deriveTransactionSemantics>['kind']; paymentMethod: string | null }
): boolean {
  if (transaction.direction !== 'outgoing') return true;
  if (resolution?.entity_type === 'own_transfer') return true;
  if (semantics.kind === 'cash_withdrawal' || semantics.kind === 'cash_deposit') return true;
  if (resolution?.entity_type === 'counterparty'
    && (isPaymentProcessor(resolution.display_name) || isTechnicalPaymentParty(resolution.display_name))) return true;
  return false;
}

function exclusionMethod(
  transaction: PayeeTransactionRow,
  resolution: ResolutionRow | undefined,
  semantics: { kind: ReturnType<typeof deriveTransactionSemantics>['kind']; paymentMethod: string | null }
): string {
  if (transaction.direction !== 'outgoing') return 'incoming';
  if (resolution?.entity_type === 'own_transfer') return 'own_transfer';
  if (semantics.kind === 'cash_withdrawal' || semantics.kind === 'cash_deposit') return semantics.kind;
  return 'technical_party';
}

function chooseDisplayName(identifiers: Array<PayeeIdentifierEvidence & { identifierHash?: string }>): {
  name: string;
  source: string;
  rank: number;
} {
  const ranked = identifiers
    .filter((item) => item.displayName?.trim())
    .map((item) => ({
      name: item.displayName!.trim().slice(0, 200),
      source: item.source,
      rank: displayRank(item.source, item.identifierType)
    }))
    .sort((left, right) => right.rank - left.rank || left.name.localeCompare(right.name));
  return ranked[0] ?? { name: 'Unknown payee', source: 'identifier', rank: 0 };
}

function displayRank(source: string, type: PayeeIdentifierType): number {
  if (type === 'sepa_creditor_id') return 90;
  if (type === 'counterparty_iban') return 80;
  if (type === 'merchant_key') return 70;
  if (type === 'resolved_merchant_name') return 60;
  if (source.includes('provider.counterparty_name')) return 10;
  return 20;
}

function validateInput(accountId: number, hmacSecret: string, now: Date): void {
  if (!Number.isSafeInteger(accountId) || accountId < 1) throw new Error('Bank account ID is invalid.');
  if (!hmacSecret.trim()) throw new Error('COUNTERPARTY_HMAC_SECRET is not configured.');
  if (Number.isNaN(now.getTime())) throw new Error('Payee resolution time is invalid.');
}

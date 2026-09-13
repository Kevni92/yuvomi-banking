import type { DatabaseSync } from 'node:sqlite';
import type { PublicTransaction } from './transactions-query.js';
import type { TransactionSemantics } from './transaction-semantics.js';

export type TransactionTitleMode = 'smart' | 'counterparty' | 'transaction_type';

export interface BankingPresentationSettings {
  transactionTitleMode: TransactionTitleMode;
}

export interface MerchantPresentationEvidence {
  resolutionMethod?: string | null;
  evidenceSource?: string | null;
}

const DEFAULT_SETTINGS: BankingPresentationSettings = {
  transactionTitleMode: 'smart'
};

export function getPresentationSettings(
  database: DatabaseSync,
  yuvomiUserId: number
): BankingPresentationSettings {
  try {
    const row = database.prepare(`
      SELECT transaction_title_mode
      FROM banking_presentation_settings
      WHERE yuvomi_user_id = ?
      LIMIT 1
    `).get(yuvomiUserId) as { transaction_title_mode?: string } | undefined;

    return {
      transactionTitleMode: normalizeTransactionTitleMode(row?.transaction_title_mode)
    };
  } catch (error) {
    // A few isolated readers/tests build only the transaction tables. More
    // importantly, this also makes a rolling deployment safe while migration 22
    // has not been applied yet: presentation is optional and must never break
    // the transaction list.
    if (error instanceof Error && /no such table:\s*banking_presentation_settings/i.test(error.message)) {
      return { ...DEFAULT_SETTINGS };
    }
    throw error;
  }
}

export function savePresentationSettings(
  database: DatabaseSync,
  yuvomiUserId: number,
  transactionTitleMode: unknown,
  now = new Date()
): BankingPresentationSettings {
  const mode = parseTransactionTitleMode(transactionTitleMode);
  const nowIso = now.toISOString();
  database.prepare(`
    INSERT INTO banking_presentation_settings (
      yuvomi_user_id, transaction_title_mode, created_at, updated_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(yuvomi_user_id) DO UPDATE SET
      transaction_title_mode = excluded.transaction_title_mode,
      updated_at = excluded.updated_at
  `).run(yuvomiUserId, mode, nowIso, nowIso);
  return { transactionTitleMode: mode };
}

export function resolveTransactionDisplayTitle(
  transaction: Pick<
    PublicTransaction,
    | 'merchant_name'
    | 'merchant_key'
    | 'merchant_logo_available'
    | 'counterparty_name'
    | 'purpose'
  >,
  semantics: TransactionSemantics,
  mode: TransactionTitleMode,
  merchantEvidence: MerchantPresentationEvidence = {}
): string | null {
  const merchant = text(transaction.merchant_name);
  const counterparty = text(transaction.counterparty_name);
  const purpose = text(transaction.purpose);
  const specificType = semanticTitle(semantics);
  const trustedMerchant = merchant && hasTrustedMerchantEvidence(transaction, merchantEvidence)
    ? merchant
    : null;

  if (mode === 'counterparty') {
    return trustedMerchant || counterparty || merchant || purpose || specificType;
  }

  if (mode === 'transaction_type') {
    return specificType || trustedMerchant || counterparty || merchant || purpose;
  }

  // Smart mode is evidence-driven: a merchant only wins when it has explicit,
  // learned or deterministic merchant evidence. Otherwise a bank-reported
  // operation such as Apple Pay/card payment or a cash withdrawal is stronger
  // than an unverified counterparty label. No institution-name blacklist is
  // involved in this decision.
  if (trustedMerchant) return trustedMerchant;
  if (semantics.preferDisplay && specificType) return specificType;
  return counterparty || merchant || purpose || specificType;
}

export function parseTransactionTitleMode(value: unknown): TransactionTitleMode {
  if (value === 'smart' || value === 'counterparty' || value === 'transaction_type') return value;
  throw new PresentationSettingsValidationError('Unknown transaction title mode.');
}

export class PresentationSettingsValidationError extends Error {}

function normalizeTransactionTitleMode(value: unknown): TransactionTitleMode {
  try {
    return parseTransactionTitleMode(value);
  } catch {
    return DEFAULT_SETTINGS.transactionTitleMode;
  }
}

function semanticTitle(semantics: TransactionSemantics): string | null {
  if (semantics.kind === 'cash_withdrawal') return 'Bargeldauszahlung';
  if (semantics.kind === 'cash_deposit') return 'Bargeldeinzahlung';
  if (semantics.kind === 'card_payment' && text(semantics.paymentMethod)) {
    return text(semantics.paymentMethod);
  }
  if (semantics.kind === 'card_payment' && semantics.description) {
    return prettyProviderDescription(semantics.description);
  }
  return text(semantics.displayLabel) || text(semantics.label) || text(semantics.description);
}

function hasTrustedMerchantEvidence(
  transaction: Pick<PublicTransaction, 'merchant_key' | 'merchant_logo_available'>,
  evidence: MerchantPresentationEvidence
): boolean {
  if (text(transaction.merchant_key) || Number(transaction.merchant_logo_available) === 1) return true;
  const method = text(evidence.resolutionMethod);
  if (method === 'manual' || method === 'provider_explicit' || method === 'registry_alias') return true;
  if (method !== 'external_enrichment') return false;

  const source = text(evidence.evidenceSource) || '';
  return source === 'own_account'
    || source.includes('provider_merchant')
    || source.includes('.counterparty_name')
    || source.includes('.purpose')
    || source === 'transaction.purpose';
}

function prettyProviderDescription(value: string): string {
  const normalized = value.trim();
  if (/^E[- ]?COM\s*\(APPLE PAY\)$/i.test(normalized)) return 'E-COM (Apple Pay)';
  if (/^E[- ]?COM\s*\(GOOGLE PAY\)$/i.test(normalized)) return 'E-COM (Google Pay)';
  if (/^BARGELDAUSZAHLUNG$/i.test(normalized)) return 'Bargeldauszahlung';
  if (/^BARGELDEINZAHLUNG$/i.test(normalized)) return 'Bargeldeinzahlung';
  return normalized;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

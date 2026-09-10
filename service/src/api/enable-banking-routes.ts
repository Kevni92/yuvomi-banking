import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import express, { type Response } from 'express';
import { config } from '../config.js';
import {
  EnableBankingClient,
  type Aspsp,
  type AccountResource,
  type AuthorizeSessionResponse,
  type StartAuthorizationRequest
} from '../enable-banking/client.js';
import {
  calculateConsentValidUntil,
  parseMaximumConsentValidity
} from '../enable-banking/consent.js';
import { importTransactions } from '../enable-banking/importer.js';
import { persistAccountBalanceSnapshots } from '../enable-banking/balances.js';
import { createEncryptionService } from '../security/encryption.js';
import { maskIban, normalizeIban } from '../services/counterparty.js';
import { reconcileWeeklyBudgetLifecycle } from '../services/weekly-budget-revisions.js';
import {
  mutationIsAllowed,
  noStore,
  resolveAuthorizedUser,
  type SessionResolver
} from './route-security.js';

const API_PREFIX = '/api/extensions/banking';
const CALLBACK_PATH = `${API_PREFIX}/enablebanking/callback`;

export function createEnableBankingRouter({
  database,
  client,
  resolveSession
}: {
  database: DatabaseSync;
  client: EnableBankingClient;
  resolveSession: SessionResolver;
}): express.Router {
  const router = express.Router();

  router.get('/csrf', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;

    const token = crypto.randomBytes(32).toString('base64url');
    response.setHeader('Set-Cookie', [
      `banking.csrf=${token}; Path=${API_PREFIX}; SameSite=Lax${isHttpsOrigin() ? '; Secure' : ''}`
    ]);
    noStore(response);
    response.json({ csrf_token: token });
  });

  router.get('/aspsps', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;

    try {
      const country = queryString(request.query.country);
      const name = queryString(request.query.name);
      const result = await client.getAspsps({
        country,
        psuType: 'personal',
        service: 'AIS',
        name
      });
      noStore(response);
      response.json({ data: result.aspsps });
    } catch {
      safeProviderError(response);
    }
  });

  router.post('/enablebanking/start', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user || !mutationIsAllowed(request, response)) return;

    const country = bodyString(request.body?.country, 2)?.toUpperCase();
    const name = bodyString(request.body?.name, 200);
    if (!country || !/^[A-Z]{2}$/.test(country) || !name) {
      response.status(400).json({ error: 'ASPSP country and name are required.' });
      return;
    }

    let aspsp: Aspsp | undefined;
    try {
      // Do not trust the browser's selected metadata. The provider response is
      // fetched again on the server immediately before the consent is built.
      const available = await client.getAspsps({
        country,
        psuType: 'personal',
        service: 'AIS'
      });
      aspsp = selectAspsp(available.aspsps, country, name);
    } catch {
      safeProviderError(response);
      return;
    }
    if (!aspsp) {
      response.status(400).json({ error: 'Selected ASPSP is not available for AIS.' });
      return;
    }

    const state = crypto.randomUUID();
    const stateHash = hashState(state);
    const stateExpiresAt = new Date(Date.now() + 15 * 60 * 1_000).toISOString();
    const maximumConsentValidity = parseMaximumConsentValidity(aspsp.maximum_consent_validity);
    const validUntil = calculateConsentValidUntil({
      now: new Date(),
      maximumConsentValidity
    });
    const now = new Date().toISOString();
    const redirectUrl = new URL(CALLBACK_PATH, `${config.publicOrigin}/`).toString();
    const insert = database.prepare(`
      INSERT INTO enable_banking_connections (
        yuvomi_user_id, aspsp_name, aspsp_country,
        aspsp_maximum_consent_validity, valid_until,
        state_hash, state_expires_at, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `);

    let connectionId: number | undefined;
    try {
      const result = insert.run(
        user.id,
        name,
        country,
        maximumConsentValidity,
        validUntil,
        stateHash,
        stateExpiresAt,
        now,
        now
      );
      connectionId = Number(result.lastInsertRowid);
      const body: StartAuthorizationRequest = {
        access: { valid_until: validUntil, balances: true, transactions: true },
        aspsp: { name, country },
        state,
        redirect_url: redirectUrl,
        psu_type: 'personal',
        language: 'de'
      };
      const authorization = await client.startAuthorization(body);
      const providerUrl = providerRedirectUrl(authorization.url);
      database.prepare(`
        UPDATE enable_banking_connections
        SET authorization_id = ?, updated_at = ?
        WHERE id = ? AND yuvomi_user_id = ?
      `).run(authorization.authorization_id, new Date().toISOString(), connectionId, user.id);

      noStore(response);
      response.status(201).json({ data: { connection_id: connectionId, url: providerUrl } });
    } catch {
      if (connectionId !== undefined) {
        database.prepare(`
          UPDATE enable_banking_connections
          SET status = 'failed', updated_at = ?
          WHERE id = ? AND yuvomi_user_id = ?
        `).run(new Date().toISOString(), connectionId, user.id);
      }
      safeProviderError(response);
    }
  });

  router.get('/enablebanking/callback', async (request, response) => {
    const state = queryString(request.query.state);
    const code = queryString(request.query.code);
    const error = queryString(request.query.error);
    if (!state) {
      response.status(400).json({ error: 'Bank authorization state is missing.' });
      return;
    }

    // Claim the state in a short local transaction before doing any provider
    // request. Clearing state_hash makes a replay fail even while the first
    // callback is waiting for Enable Banking.
    const connection = claimAuthorizationState(database, hashState(state), new Date());
    if (!connection) {
      response.status(400).json({ error: 'Bank authorization state is invalid or expired.' });
      return;
    }
    if (error || !code) {
      markConnectionFailed(database, connection.id);
      redirectToModule(response, 'error');
      return;
    }

    let providerSessionId: string | undefined;
    try {
      const session = await client.authorizeSession(code);
      providerSessionId = stringOrNull(session.session_id) ?? undefined;
      if (!providerSessionId) throw new Error('Provider session ID is missing.');

      // Normalize and encrypt all provider data before opening the local write
      // transaction. POST /sessions already returns AccountResource objects,
      // so no /details call is needed for the normal callback path.
      const encryption = createEncryptionService();
      const accounts = normalizeAccountResources(session.accounts, encryption);
      persistAuthorizedSession(database, connection, session, accounts);
      redirectToModule(response, 'connected');
    } catch {
      if (providerSessionId) await cleanupProviderSession(client, providerSessionId);
      markConnectionFailed(database, connection.id);
      redirectToModule(response, 'error');
    }
  });

  router.get('/connections', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;
    const connections = database.prepare(`
      SELECT id, aspsp_name, aspsp_country, valid_until, status,
             created_at, updated_at
      FROM enable_banking_connections
      WHERE yuvomi_user_id = ?
      ORDER BY created_at DESC
    `).all(user.id);
    noStore(response);
    response.json({ data: connections });
  });

  router.get('/accounts', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;
    const accounts = database.prepare(`
      SELECT bank_accounts.id, bank_accounts.provider_account_id,
             bank_accounts.display_name, bank_accounts.iban_encrypted,
             bank_accounts.currency, bank_accounts.account_type,
             bank_accounts.last_synced_at, enable_banking_connections.aspsp_name,
             enable_banking_connections.aspsp_country
      FROM bank_accounts
      JOIN enable_banking_connections
        ON enable_banking_connections.id = bank_accounts.connection_id
      WHERE enable_banking_connections.yuvomi_user_id = ?
      ORDER BY bank_accounts.display_name, bank_accounts.id
    `).all(user.id) as Array<Record<string, unknown>>;
    const publicAccounts = accounts.map((account) => ({
      id: account.id,
      display_name: account.display_name,
      iban_masked: maskedStoredIban(account.iban_encrypted),
      currency: account.currency,
      account_type: account.account_type,
      last_synced_at: account.last_synced_at,
      aspsp_name: account.aspsp_name,
      aspsp_country: account.aspsp_country
    }));
    noStore(response);
    response.json({ data: publicAccounts });
  });

  router.get('/accounts/:accountId/balances', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;
    const account = ownedAccount(database, request.params.accountId, user.id);
    if (!account) {
      response.status(404).json({ error: 'Bank account not found.' });
      return;
    }
    try {
      const balances = await client.getAccountBalances(account.provider_account_id);
      const persisted = persistAccountBalanceSnapshots({
        database,
        accountId: account.id,
        balances: balances.balances,
        expectedCurrency: account.currency
      });
      noStore(response);
      response.json({
        data: balances.balances,
        meta: {
          fetched_at: persisted.snapshots[0]?.fetchedAt ?? null,
          usable_balance: persisted.usableBalance
            ? {
                snapshot_id: persisted.usableBalance.id,
                amount_cents: persisted.usableBalance.amountCents,
                currency: persisted.usableBalance.currency,
                balance_type: persisted.usableBalance.providerBalanceType,
                observed_at: persisted.usableBalance.observedAt
              }
            : null
        }
      });
    } catch {
      safeProviderError(response);
    }
  });

  router.get('/accounts/:accountId/transactions', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;
    const account = ownedAccount(database, request.params.accountId, user.id);
    if (!account) {
      response.status(404).json({ error: 'Bank account not found.' });
      return;
    }
    noStore(response);
    response.json({ data: { transactions: listPublicTransactions(database, account.id) } });
  });

  router.post('/accounts/:accountId/sync', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user || !mutationIsAllowed(request, response)) return;
    const account = ownedAccount(database, request.params.accountId, user.id);
    if (!account) {
      response.status(404).json({ error: 'Bank account not found.' });
      return;
    }
    try {
      const result = await client.getAllAccountTransactions(account.provider_account_id, {
        dateFrom: queryString(request.query.date_from),
        dateTo: queryString(request.query.date_to),
        transactionStatus: queryString(request.query.transaction_status),
        strategy: queryString(request.query.strategy)
      });
      const importResult = importTransactions({
        database,
        accountId: account.id,
        transactions: result.transactions,
        hmacSecret: config.secrets.counterpartyHmac,
        encryption: createEncryptionService()
      });
      database.prepare(
        'UPDATE bank_accounts SET last_synced_at = ?, updated_at = ? WHERE id = ?'
      ).run(new Date().toISOString(), new Date().toISOString(), account.id);
      reconcileWeeklyBudgetsForAccount(database, account.id, new Date());
      noStore(response);
      response.json({
        data: {
          pages: result.pages,
          imported: importResult,
          transactions: listPublicTransactions(database, account.id)
        }
      });
    } catch {
      safeProviderError(response);
    }
  });

  return router;
}

function ownedAccount(
  database: DatabaseSync,
  accountId: string,
  userId: number
): { id: number; provider_account_id: string; currency: string | null } | undefined {
  if (!/^\d+$/.test(accountId)) return undefined;
  return database.prepare(`
    SELECT bank_accounts.id, bank_accounts.provider_account_id,
           bank_accounts.currency
    FROM bank_accounts
    JOIN enable_banking_connections
      ON enable_banking_connections.id = bank_accounts.connection_id
    WHERE bank_accounts.id = ? AND enable_banking_connections.yuvomi_user_id = ?
  `).get(Number(accountId), userId) as {
    id: number;
    provider_account_id: string;
    currency: string | null;
  } | undefined;
}

function listPublicTransactions(database: DatabaseSync, accountId: number): Array<Record<string, unknown>> {
  const rows = database.prepare(`
    SELECT transactions.id, transactions.booking_date, transactions.value_date,
           transactions.transaction_date, transactions.amount_cents,
           transactions.currency, transactions.direction,
           transactions.counterparty_name, transactions.purpose,
           transactions.merchant_name, transactions.status,
           transactions.category_id, transactions.category_source,
           transactions.category_confidence,
           transactions.weekly_budget_override,
           categories.weekly_budget_default AS category_weekly_budget_default
    FROM transactions
    LEFT JOIN categories ON categories.id = transactions.category_id
    WHERE transactions.account_id = ?
    ORDER BY COALESCE(transactions.booking_date, transactions.value_date) DESC,
             transactions.id DESC
    LIMIT 100
  `).all(accountId) as Array<Record<string, unknown>>;

  return rows.map(({ amount_cents, ...row }) => ({
    ...row,
    // Keep the browser contract display-friendly without persisting or
    // calculating money as a floating-point value.
    amount: formatMinorUnits(amount_cents, row.currency)
  }));
}

function selectAspsp(aspsps: Aspsp[], country: string, name: string): Aspsp | undefined {
  if (!Array.isArray(aspsps)) return undefined;
  const normalizedCountry = normalizeLookupValue(country);
  const normalizedName = normalizeLookupValue(name);
  const matches = aspsps.filter((aspsp) =>
    normalizeLookupValue(stringOrNull(aspsp?.country) ?? '') === normalizedCountry
    && normalizeLookupValue(stringOrNull(aspsp?.name) ?? '') === normalizedName
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function normalizeLookupValue(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function maskedStoredIban(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    return maskIban(createEncryptionService().decrypt(value));
  } catch {
    return null;
  }
}

function providerRedirectUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/(^|\.)enablebanking\.com$/i.test(url.hostname)) {
    throw new Error('Provider redirect URL is not trusted.');
  }
  return url.toString();
}

function redirectToModule(response: Response, status: 'connected' | 'error'): void {
  const url = new URL('/m/banking', `${config.publicOrigin}/`);
  url.searchParams.set('banking', status);
  response.redirect(303, url.toString());
}

function markConnectionFailed(database: DatabaseSync, connectionId: number): void {
  database.prepare(`
    UPDATE enable_banking_connections
    SET status = 'failed', updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), connectionId);
}

interface ClaimedConnection {
  id: number;
  yuvomi_user_id: number;
}

function claimAuthorizationState(
  database: DatabaseSync,
  stateHash: string,
  now: Date
): ClaimedConnection | undefined {
  const nowIso = now.toISOString();
  database.exec('BEGIN IMMEDIATE;');
  try {
    const connection = database.prepare(`
      SELECT id, yuvomi_user_id, state_expires_at
      FROM enable_banking_connections
      WHERE state_hash = ? AND status = 'pending'
      LIMIT 1
    `).get(stateHash) as {
      id: number;
      yuvomi_user_id: number;
      state_expires_at: string | null;
    } | undefined;

    if (!connection) {
      database.exec('COMMIT;');
      return undefined;
    }

    const expiresAt = connection.state_expires_at
      ? Date.parse(connection.state_expires_at)
      : Number.NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
      database.prepare(`
        UPDATE enable_banking_connections
        SET state_hash = NULL, status = 'failed', state_claimed_at = ?, updated_at = ?
        WHERE id = ? AND state_hash = ? AND status = 'pending'
      `).run(nowIso, nowIso, connection.id, stateHash);
      database.exec('COMMIT;');
      return undefined;
    }

    const claim = database.prepare(`
      UPDATE enable_banking_connections
      SET state_hash = NULL, status = 'exchanging', state_claimed_at = ?, updated_at = ?
      WHERE id = ? AND state_hash = ? AND status = 'pending'
    `).run(nowIso, nowIso, connection.id, stateHash);
    if (Number(claim.changes) !== 1) {
      database.exec('COMMIT;');
      return undefined;
    }

    database.exec('COMMIT;');
    return { id: connection.id, yuvomi_user_id: connection.yuvomi_user_id };
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve the original state-claim error.
    }
    throw error;
  }
}

interface PreparedAccount {
  providerAccountId: string;
  identificationHash: string;
  displayName: string | null;
  ibanEncrypted: string | null;
  currency: string;
  accountType: string;
}

function normalizeAccountResources(
  accounts: AccountResource[],
  encryption: ReturnType<typeof createEncryptionService>
): PreparedAccount[] {
  if (!Array.isArray(accounts)) throw new Error('Provider account resources are missing.');

  const providerIds = new Set<string>();
  const identificationHashes = new Set<string>();
  return accounts.map((account) => {
    const providerAccountId = stringOrNull(account?.uid);
    const identificationHash = stringOrNull(account?.identification_hash);
    const currency = stringOrNull(account?.currency)?.toUpperCase();
    const accountType = stringOrNull(account?.cash_account_type);
    if (!providerAccountId || !identificationHash || !currency || !accountType) {
      throw new Error('Provider account resource is incomplete.');
    }
    if (providerIds.has(providerAccountId) || identificationHashes.has(identificationHash)) {
      throw new Error('Provider returned duplicate account resources.');
    }
    providerIds.add(providerAccountId);
    identificationHashes.add(identificationHash);

    const iban = stringOrNull(account?.account_id?.iban);
    return {
      providerAccountId,
      identificationHash,
      displayName: stringOrNull(account?.name),
      ibanEncrypted: iban ? encryption.encrypt(normalizeIban(iban)) : null,
      currency,
      accountType
    };
  });
}

function persistAuthorizedSession(
  database: DatabaseSync,
  connection: ClaimedConnection,
  session: AuthorizeSessionResponse,
  accounts: PreparedAccount[]
): void {
  const now = new Date().toISOString();
  database.exec('BEGIN IMMEDIATE;');
  try {
    const connectionUpdate = database.prepare(`
      UPDATE enable_banking_connections
      SET provider_session_id = ?, status = 'authorized', updated_at = ?
      WHERE id = ? AND yuvomi_user_id = ? AND status = 'exchanging'
    `).run(
      session.session_id,
      now,
      connection.id,
      connection.yuvomi_user_id
    );
    if (Number(connectionUpdate.changes) !== 1) {
      throw new Error('Authorization state is no longer exchangeable.');
    }

    const findByIdentity = database.prepare(`
      SELECT bank_accounts.id
      FROM bank_accounts
      JOIN enable_banking_connections
        ON enable_banking_connections.id = bank_accounts.connection_id
      WHERE bank_accounts.identification_hash = ?
        AND enable_banking_connections.yuvomi_user_id = ?
      ORDER BY bank_accounts.id
      LIMIT 1
    `);
    const findOnConnection = database.prepare(`
      SELECT id
      FROM bank_accounts
      WHERE connection_id = ? AND provider_account_id = ?
      LIMIT 1
    `);
    const updateAccount = database.prepare(`
      UPDATE bank_accounts
      SET connection_id = ?, provider_account_id = ?, display_name = ?,
          iban_encrypted = COALESCE(?, iban_encrypted), currency = ?,
          account_type = ?, identification_hash = ?, updated_at = ?
      WHERE id = ?
    `);
    const insertAccount = database.prepare(`
      INSERT INTO bank_accounts (
        connection_id, provider_account_id, display_name, iban_encrypted,
        currency, account_type, identification_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const account of accounts) {
      const byIdentity = findByIdentity.get(
        account.identificationHash,
        connection.yuvomi_user_id
      ) as { id: number } | undefined;
      const existing = byIdentity ?? findOnConnection.get(
        connection.id,
        account.providerAccountId
      ) as { id: number } | undefined;

      if (existing) {
        updateAccount.run(
          connection.id,
          account.providerAccountId,
          account.displayName,
          account.ibanEncrypted,
          account.currency,
          account.accountType,
          account.identificationHash,
          now,
          existing.id
        );
      } else {
        insertAccount.run(
          connection.id,
          account.providerAccountId,
          account.displayName,
          account.ibanEncrypted,
          account.currency,
          account.accountType,
          account.identificationHash,
          now,
          now
        );
      }
    }
    database.exec('COMMIT;');
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve the original persistence error.
    }
    throw error;
  }
}

async function cleanupProviderSession(client: EnableBankingClient, sessionId: string): Promise<void> {
  try {
    await client.deleteSession(sessionId);
  } catch {
    // Provider cleanup is best effort and must never hide the local error.
  }
}

function formatMinorUnits(value: unknown, currency: unknown): string {
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(amount)) return '';
  const code = typeof currency === 'string' ? currency.toUpperCase() : '';
  const minorDigits = code === 'JPY' ? 0 : 2;
  const negative = amount < 0;
  const absolute = Math.abs(amount).toString().padStart(minorDigits + 1, '0');
  if (minorDigits === 0) return `${negative ? '-' : ''}${absolute}`;
  const split = absolute.length - minorDigits;
  return `${negative ? '-' : ''}${absolute.slice(0, split)}.${absolute.slice(split)}`;
}

function bodyString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.trim().length <= maxLength
    ? value.trim() || null
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function hashState(state: string): string {
  return crypto.createHash('sha256').update(state, 'utf8').digest('hex');
}

function isHttpsOrigin(): boolean {
  try {
    return new URL(config.publicOrigin).protocol === 'https:';
  } catch {
    return false;
  }
}

function reconcileWeeklyBudgetsForAccount(
  database: DatabaseSync,
  accountId: number,
  now: Date
): void {
  const configs = database.prepare(`
    SELECT id FROM weekly_budget_configs
    WHERE source_account_id = ? OR target_account_id = ?
  `).all(accountId, accountId) as Array<{ id: number }>;
  for (const weeklyBudgetConfig of configs) {
    reconcileWeeklyBudgetLifecycle(database, Number(weeklyBudgetConfig.id), now);
  }
}

function safeProviderError(response: Response): void {
  noStore(response);
  response.status(502).json({ error: 'Banking provider request failed.' });
}

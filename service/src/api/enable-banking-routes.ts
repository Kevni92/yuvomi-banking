import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import express, { type Request, type Response } from 'express';
import { config } from '../config.js';
import {
  EnableBankingClient,
  type StartAuthorizationRequest
} from '../enable-banking/client.js';
import { importTransactions } from '../enable-banking/importer.js';
import { createEncryptionService } from '../security/encryption.js';
import { maskIban } from '../services/counterparty.js';
import type { YuvomiUser } from '../auth/yuvomi-session.js';
import { bankingPermission } from '../auth/yuvomi-session.js';

const API_PREFIX = '/api/extensions/banking';
const CALLBACK_PATH = `${API_PREFIX}/enablebanking/callback`;

type SessionResolver = (cookieHeader?: string) => Promise<YuvomiUser | null>;

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
      const result = await client.getAspsps({ country, name });
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

    const state = crypto.randomUUID();
    const stateHash = hashState(state);
    const validUntil = new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000).toISOString();
    const now = new Date().toISOString();
    const redirectUrl = new URL(CALLBACK_PATH, `${config.publicOrigin}/`).toString();
    const insert = database.prepare(`
      INSERT INTO enable_banking_connections (
        yuvomi_user_id, aspsp_name, aspsp_country, valid_until,
        state_hash, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `);

    let connectionId: number | undefined;
    try {
      const result = insert.run(user.id, name, country, validUntil, stateHash, now, now);
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

    const connection = database.prepare(`
      SELECT id, yuvomi_user_id, valid_until
      FROM enable_banking_connections
      WHERE state_hash = ? AND status = 'pending'
    `).get(hashState(state)) as {
      id: number;
      yuvomi_user_id: number;
      valid_until: string | null;
    } | undefined;
    if (!connection) {
      response.status(400).json({ error: 'Bank authorization state is invalid or expired.' });
      return;
    }
    if (error || !code) {
      markConnectionFailed(database, connection.id);
      redirectToModule(response, 'error');
      return;
    }

    try {
      const session = await client.authorizeSession(code);
      if (!session.session_id.trim()) throw new Error('Provider session ID is missing.');
      const encryption = createEncryptionService();
      const now = new Date().toISOString();

      database.exec('BEGIN IMMEDIATE;');
      try {
        database.prepare(`
          UPDATE enable_banking_connections
          SET provider_session_id = ?, valid_until = COALESCE(?, valid_until),
              status = 'authorized', updated_at = ?
          WHERE id = ?
        `).run(
          session.session_id,
          session.access?.valid_until ?? null,
          now,
          connection.id
        );

        if (Array.isArray(session.accounts)) {
          for (const providerAccountId of session.accounts) {
            if (typeof providerAccountId !== 'string' || !providerAccountId.trim()) continue;
            const details = await client.getAccountDetails(providerAccountId);
            const iban = typeof details.iban === 'string' ? details.iban : null;
            database.prepare(`
              INSERT INTO bank_accounts (
                connection_id, provider_account_id, display_name, iban_encrypted,
                currency, account_type, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(connection_id, provider_account_id) DO UPDATE SET
                display_name = excluded.display_name,
                iban_encrypted = COALESCE(excluded.iban_encrypted, bank_accounts.iban_encrypted),
                currency = excluded.currency,
                account_type = excluded.account_type,
                updated_at = excluded.updated_at
            `).run(
              connection.id,
              providerAccountId,
              stringOrNull(details.name),
              iban ? encryption.encrypt(iban) : null,
              stringOrNull(details.currency),
              stringOrNull(details.account_type),
              now,
              now
            );
          }
        }
        database.exec('COMMIT;');
      } catch (transactionError) {
        try {
          database.exec('ROLLBACK;');
        } catch {
          // Preserve the original callback error.
        }
        throw transactionError;
      }
      redirectToModule(response, 'connected');
    } catch {
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
      provider_account_id: account.provider_account_id,
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
      noStore(response);
      response.json({ data: balances.balances });
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

async function resolveAuthorizedUser(
  request: Request,
  response: Response,
  resolveSession: SessionResolver,
  required: 'read' | 'write'
): Promise<YuvomiUser | null> {
  try {
    const user = await resolveSession(request.get('cookie') ?? undefined);
    if (!user) {
      response.status(401).json({ error: 'Not authenticated.' });
      return null;
    }
    const permission = bankingPermission(user);
    if (permission === 'none' || (required === 'write' && permission !== 'write')) {
      response.status(403).json({ error: 'Banking module access denied.' });
      return null;
    }
    return user;
  } catch {
    response.status(502).json({ error: 'Unable to verify Yuvomi session.' });
    return null;
  }
}

function mutationIsAllowed(request: Request, response: Response): boolean {
  const origin = request.get('origin');
  if (!origin || !sameOrigin(origin, config.publicOrigin)) {
    response.status(403).json({ error: 'Origin check failed.' });
    return false;
  }
  const headerToken = request.get('x-banking-csrf');
  const cookieToken = cookieValue(request.get('cookie'), 'banking.csrf');
  if (!headerToken || !cookieToken || !safeTokenEqual(headerToken, cookieToken)) {
    response.status(403).json({ error: 'CSRF check failed.' });
    return false;
  }
  return true;
}

function safeTokenEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=') || null;
  }
  return null;
}

function ownedAccount(
  database: DatabaseSync,
  accountId: string,
  userId: number
): { id: number; provider_account_id: string } | undefined {
  if (!/^\d+$/.test(accountId)) return undefined;
  return database.prepare(`
    SELECT bank_accounts.id, bank_accounts.provider_account_id
    FROM bank_accounts
    JOIN enable_banking_connections
      ON enable_banking_connections.id = bank_accounts.connection_id
    WHERE bank_accounts.id = ? AND enable_banking_connections.yuvomi_user_id = ?
  `).get(Number(accountId), userId) as { id: number; provider_account_id: string } | undefined;
}

function listPublicTransactions(database: DatabaseSync, accountId: number): Array<Record<string, unknown>> {
  return database.prepare(`
    SELECT id, booking_date, value_date, amount, currency, direction,
           counterparty_name, purpose, merchant_name, category_id,
           category_source, category_confidence
    FROM transactions
    WHERE account_id = ?
    ORDER BY COALESCE(booking_date, value_date) DESC, id DESC
    LIMIT 100
  `).all(accountId) as Array<Record<string, unknown>>;
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

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function isHttpsOrigin(): boolean {
  try {
    return new URL(config.publicOrigin).protocol === 'https:';
  } catch {
    return false;
  }
}

function noStore(response: Response): void {
  response.setHeader('Cache-Control', 'no-store');
}

function safeProviderError(response: Response): void {
  noStore(response);
  response.status(502).json({ error: 'Banking provider request failed.' });
}

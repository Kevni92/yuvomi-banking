import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from '../src/db/database.js';
import {
  EnableBankingClient,
  type EnableBankingFetch
} from '../src/enable-banking/client.js';
import { importTransactions } from '../src/enable-banking/importer.js';
import { createEnableBankingJwt } from '../src/enable-banking/jwt.js';
import { createEncryptionService } from '../src/security/encryption.js';

const TEST_KEY = 'cd'.repeat(32);

test('creates a verifiable RS256 JWT with the current Enable Banking claims', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2_048 });
  const jwt = createEnableBankingJwt({
    applicationId: 'application-test-id',
    privateKey,
    nowSeconds: 1_700_000_000,
    ttlSeconds: 3_600
  });
  const [encodedHeader, encodedPayload, encodedSignature] = jwt.split('.');
  const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));

  assert.deepEqual(header, { typ: 'JWT', alg: 'RS256', kid: 'application-test-id' });
  assert.deepEqual(payload, {
    iss: 'enablebanking.com',
    aud: 'api.enablebanking.com',
    iat: 1_700_000_000,
    exp: 1_700_003_600
  });
  assert.equal(
    crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'),
      publicKey,
      Buffer.from(encodedSignature, 'base64url')
    ),
    true
  );
});

test('uses official provider paths and follows continuation_key pagination', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2_048 });
  const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
  const fetcher: EnableBankingFetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      authorization: new Headers(init?.headers).get('authorization')
    });

    if (url.endsWith('/aspsps?country=DE')) {
      return new Response(JSON.stringify({ aspsps: [{ name: 'Mock Bank', country: 'DE' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (url.endsWith('/accounts/account-1/transactions?date_from=2026-01-01')) {
      return new Response(JSON.stringify({
        transactions: [{ entry_reference: 'one' }],
        continuation_key: 'next-page'
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/accounts/account-1/transactions?date_from=2026-01-01&continuation_key=next-page')) {
      return new Response(JSON.stringify({
        transactions: [{ entry_reference: 'two' }],
        continuation_key: null
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  };
  const client = new EnableBankingClient({
    apiUrl: 'https://provider.test',
    applicationId: 'application-test-id',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    fetcher
  });

  assert.deepEqual(await client.getAspsps({ country: 'DE' }), {
    aspsps: [{ name: 'Mock Bank', country: 'DE' }]
  });
  assert.deepEqual(await client.getAllAccountTransactions('account-1', {
    dateFrom: '2026-01-01'
  }), {
    transactions: [{ entry_reference: 'one' }, { entry_reference: 'two' }],
    pages: 2
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.authorization?.startsWith('Bearer ey')));
  assert.equal(calls[1].url, 'https://provider.test/accounts/account-1/transactions?date_from=2026-01-01');
  assert.equal(
    calls[2].url,
    'https://provider.test/accounts/account-1/transactions?date_from=2026-01-01&continuation_key=next-page'
  );
});

test('imports transactions idempotently and stores counterparty IBAN encrypted', () => {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  database.prepare(`
    INSERT INTO enable_banking_connections (
      yuvomi_user_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?)
  `).run(1, 'authorized', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  const connectionId = Number(database.prepare('SELECT id FROM enable_banking_connections').get()?.id);
  database.prepare(`
    INSERT INTO bank_accounts (
      connection_id, provider_account_id, display_name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(connectionId, 'provider-account-1', 'Checking', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  const accountId = Number(database.prepare('SELECT id FROM bank_accounts').get()?.id);
  const encryption = createEncryptionService(TEST_KEY);
  const iban = 'DE89 3704 0044 0532 0130 00';
  const transaction = {
    entry_reference: 'stable-entry-1',
    transaction_amount: { amount: '12.34', currency: 'EUR' },
    credit_debit_indicator: 'DBIT',
    booking_date: '2026-01-02',
    value_date: '2026-01-02',
    creditor: { name: 'Example Merchant' },
    creditor_account: { iban },
    remittance_information: ['Invoice 123'],
    merchant_category_code: '5411'
  };

  assert.deepEqual(importTransactions({
    database,
    accountId,
    transactions: [transaction],
    hmacSecret: 'phase3-test-secret',
    encryption
  }), { inserted: 1, updated: 0 });
  assert.deepEqual(importTransactions({
    database,
    accountId,
    transactions: [transaction],
    hmacSecret: 'phase3-test-secret',
    encryption
  }), { inserted: 0, updated: 1 });
  assert.equal(database.prepare('SELECT count(*) AS count FROM transactions').get()?.count, 1);
  const stored = database.prepare(
    'SELECT counterparty_name, purpose, iban_encrypted FROM counterparties JOIN transactions ON transactions.counterparty_ref = counterparties.id'
  ).get() as { counterparty_name?: string; purpose?: string; iban_encrypted: string };
  assert.equal(stored.counterparty_name, 'Example Merchant');
  assert.equal(stored.purpose, 'Invoice 123');
  assert.ok(!stored.iban_encrypted.includes(iban));
  assert.equal(encryption.decrypt(stored.iban_encrypted), 'DE89370400440532013000');
  database.close();
});

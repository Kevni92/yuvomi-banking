import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from '../src/db/database.js';
import {
  EnableBankingClient,
  type EnableBankingFetch
} from '../src/enable-banking/client.js';
import {
  importTransactions,
  normalizeForFingerprint
} from '../src/enable-banking/importer.js';
import { calculateConsentValidUntil } from '../src/enable-banking/consent.js';
import { createEnableBankingJwt } from '../src/enable-banking/jwt.js';
import { createEncryptionService } from '../src/security/encryption.js';

const TEST_KEY = 'cd'.repeat(32);

function transactionFixture(): {
  database: DatabaseSync;
  accountId: number;
  encryption: ReturnType<typeof createEncryptionService>;
} {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  database.prepare(`
    INSERT INTO enable_banking_connections (
      yuvomi_user_id, status, created_at, updated_at
    ) VALUES (?, 'authorized', ?, ?)
  `).run(1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  const connectionId = Number(database.prepare(
    'SELECT id FROM enable_banking_connections'
  ).get()?.id);
  database.prepare(`
    INSERT INTO bank_accounts (
      connection_id, provider_account_id, display_name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    connectionId,
    'provider-account-1',
    'Checking',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z'
  );
  return {
    database,
    accountId: Number(database.prepare('SELECT id FROM bank_accounts').get()?.id),
    encryption: createEncryptionService(TEST_KEY)
  };
}

test('calculates consent validity from ASPSP maximums and uses a conservative fallback', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const day = 24 * 60 * 60;
  assert.equal(
    calculateConsentValidUntil({ now, maximumConsentValidity: 30 * day }),
    '2026-01-31T00:00:00.000Z'
  );
  assert.equal(
    calculateConsentValidUntil({ now, maximumConsentValidity: 180 * day }),
    '2026-04-01T00:00:00.000Z'
  );
  assert.equal(
    calculateConsentValidUntil({ now }),
    '2026-01-31T00:00:00.000Z'
  );
});

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

    if (url.endsWith('/aspsps?country=DE&psu_type=personal&service=AIS')) {
      return new Response(JSON.stringify({ aspsps: [
        { name: 'Mock Bank', country: 'DE' },
        { name: 'Other Bank', country: 'DE' }
      ] }), {
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
    if (url.endsWith('/sessions/session-1')) {
      return new Response(JSON.stringify({
        accounts: ['account-1'],
        accounts_data: [{
          uid: 'account-1',
          identification_hash: 'stable-account-hash',
          identification_hashes: ['stable-account-hash']
        }],
        status: 'AUTHORIZED'
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

  assert.deepEqual(await client.getAspsps({
    country: 'DE',
    psuType: 'personal',
    service: 'AIS',
    name: 'mock'
  }), {
    aspsps: [{ name: 'Mock Bank', country: 'DE' }]
  });
  assert.deepEqual(await client.getSession('session-1'), {
    accounts: ['account-1'],
    accounts_data: [{
      uid: 'account-1',
      identification_hash: 'stable-account-hash',
      identification_hashes: ['stable-account-hash']
    }],
    status: 'AUTHORIZED'
  });
  assert.deepEqual(await client.getAllAccountTransactions('account-1', {
    dateFrom: '2026-01-01'
  }), {
    transactions: [{ entry_reference: 'one' }, { entry_reference: 'two' }],
    pages: 2
  });
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.authorization?.startsWith('Bearer ey')));
  assert.equal(calls[1].url, 'https://provider.test/sessions/session-1');
  assert.equal(calls[2].url, 'https://provider.test/accounts/account-1/transactions?date_from=2026-01-01');
  assert.equal(
    calls[3].url,
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
  const raw = database.prepare('SELECT raw_payload_encrypted FROM transactions').get() as { raw_payload_encrypted: string };
  assert.ok(!raw.raw_payload_encrypted.includes('Invoice 123'));
  assert.deepEqual(JSON.parse(encryption.decrypt(raw.raw_payload_encrypted)).list, transaction);
  const updated = { ...transaction, remittance_information: ['Invoice 456'] };
  assert.deepEqual(importTransactions({
    database, accountId, transactions: [updated], hmacSecret: 'phase3-test-secret', encryption
  }), { inserted: 0, updated: 1 });
  const updatedRaw = database.prepare('SELECT raw_payload_encrypted FROM transactions').get() as { raw_payload_encrypted: string };
  assert.deepEqual(JSON.parse(encryption.decrypt(updatedRaw.raw_payload_encrypted)).list, updated);
  database.close();
});

test('deduplicates transactions without entry_reference when transaction_id changes', () => {
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
      connection_id, provider_account_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?)
  `).run(connectionId, 'provider-account-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  const accountId = Number(database.prepare('SELECT id FROM bank_accounts').get()?.id);
  const encryption = createEncryptionService(TEST_KEY);
  const transaction = {
    transaction_amount: { amount: '12.34', currency: 'EUR' },
    credit_debit_indicator: 'DBIT',
    booking_date: '2026-01-02',
    value_date: '2026-01-02',
    creditor: { name: 'Example Merchant' },
    creditor_account: { iban: 'DE89 3704 0044 0532 0130 00' },
    remittance_information: ['Invoice 123']
  };

  assert.deepEqual(importTransactions({
    database,
    accountId,
    transactions: [{ ...transaction, transaction_id: 'unstable-1' }],
    hmacSecret: 'phase3-test-secret',
    encryption
  }), { inserted: 1, updated: 0 });
  assert.deepEqual(importTransactions({
    database,
    accountId,
    transactions: [{ ...transaction, transaction_id: 'unstable-2' }],
    hmacSecret: 'phase3-test-secret',
    encryption
  }), { inserted: 0, updated: 1 });

  assert.equal(database.prepare('SELECT count(*) AS count FROM transactions').get()?.count, 1);
  const stored = database.prepare(
    'SELECT provider_transaction_id, transaction_id, amount_cents FROM transactions'
  ).get() as {
    provider_transaction_id: string;
    transaction_id: string;
    amount_cents: number;
  };
  assert.equal(stored.transaction_id, 'unstable-2');
  assert.equal(stored.amount_cents, 1234);
  assert.match(stored.provider_transaction_id, /^fingerprint:/);
  database.close();
});

test('stores provider statuses and reconciles PDNG into BOOK with a new entry reference and transaction ID', () => {
  const { database, accountId, encryption } = transactionFixture();
  const common = {
    transaction_amount: { amount: '12.34', currency: 'EUR' },
    credit_debit_indicator: 'DBIT',
    transaction_date: '2026-01-02',
    creditor: { name: 'Example Merchant' },
    creditor_account: { iban: 'DE89 3704 0044 0532 0130 00' },
    remittance_information: ['Invoice 123'],
    merchant_category_code: '5411'
  };

  assert.deepEqual(importTransactions({
    database,
    accountId,
    transactions: [{ ...common, status: 'PDNG', transaction_id: 'abc' }],
    hmacSecret: 'phase3-lifecycle-secret',
    encryption
  }), { inserted: 1, updated: 0 });
  assert.deepEqual(importTransactions({
    database,
    accountId,
    transactions: [{
      ...common,
      status: 'BOOK',
      transaction_id: 'def',
      entry_reference: 'xyz',
      booking_date: '2026-01-03',
      value_date: '2026-01-03'
    }],
    hmacSecret: 'phase3-lifecycle-secret',
    encryption
  }), { inserted: 0, updated: 1 });

  assert.equal(database.prepare('SELECT count(*) AS count FROM transactions').get()?.count, 1);
  const stored = database.prepare(`
    SELECT provider_transaction_id, entry_reference, transaction_id, status,
           booking_date, transaction_date
    FROM transactions
  `).get() as Record<string, unknown>;
  assert.equal(stored.provider_transaction_id, 'xyz');
  assert.equal(stored.entry_reference, 'xyz');
  assert.equal(stored.transaction_id, 'def');
  assert.equal(stored.status, 'BOOK');
  assert.equal(stored.booking_date, '2026-01-03');
  assert.equal(stored.transaction_date, '2026-01-02');
  database.close();
});

test('maps unknown provider statuses without rejecting the transaction', () => {
  const { database, accountId, encryption } = transactionFixture();
  const transaction = {
    status: 'OTHR',
    transaction_id: 'unknown-status-id',
    transaction_amount: { amount: '2.00', currency: 'EUR' },
    credit_debit_indicator: 'CRDT',
    booking_date: '2026-01-04',
    debtor: { name: 'Example Payer' },
    remittance_information: ['Unknown status test']
  };
  assert.deepEqual(importTransactions({
    database,
    accountId,
    transactions: [transaction],
    hmacSecret: 'phase3-status-secret',
    encryption
  }), { inserted: 1, updated: 0 });
  assert.equal(database.prepare('SELECT status FROM transactions').get()?.status, 'UNKNOWN');
  database.close();
});

test('promotes a stable fingerprint to entry_reference once the provider supplies it', () => {
  const { database, accountId, encryption } = transactionFixture();
  const transaction = {
    status: 'BOOK',
    transaction_id: 'first-provider-id',
    transaction_amount: { amount: '8.50', currency: 'EUR' },
    credit_debit_indicator: 'DBIT',
    booking_date: '2026-01-05',
    creditor: { name: 'Example Merchant' },
    creditor_account: { iban: 'DE89 3704 0044 0532 0130 00' },
    remittance_information: ['Fingerprint promotion']
  };
  assert.deepEqual(importTransactions({
    database,
    accountId,
    transactions: [transaction],
    hmacSecret: 'phase3-entry-secret',
    encryption
  }), { inserted: 1, updated: 0 });
  assert.deepEqual(importTransactions({
    database,
    accountId,
    transactions: [{
      ...transaction,
      transaction_id: 'second-provider-id',
      entry_reference: 'real-entry-reference'
    }],
    hmacSecret: 'phase3-entry-secret',
    encryption
  }), { inserted: 0, updated: 1 });

  assert.equal(database.prepare('SELECT count(*) AS count FROM transactions').get()?.count, 1);
  const stored = database.prepare(
    'SELECT provider_transaction_id, entry_reference, transaction_id FROM transactions'
  ).get() as Record<string, unknown>;
  assert.equal(stored.provider_transaction_id, 'real-entry-reference');
  assert.equal(stored.entry_reference, 'real-entry-reference');
  assert.equal(stored.transaction_id, 'second-provider-id');
  database.close();
});

test('does not reconcile similar payments with different purposes', () => {
  const { database, accountId, encryption } = transactionFixture();
  const common = {
    transaction_amount: { amount: '10.00', currency: 'EUR' },
    credit_debit_indicator: 'DBIT',
    transaction_date: '2026-01-06',
    booking_date: '2026-01-06',
    creditor: { name: 'Same Merchant' },
    creditor_account: { iban: 'DE89 3704 0044 0532 0130 00' },
    merchant_category_code: '5411'
  };
  assert.deepEqual(importTransactions({
    database,
    accountId,
    transactions: [{
      ...common,
      status: 'PDNG',
      transaction_id: 'pending-a',
      remittance_information: ['Order A']
    }],
    hmacSecret: 'phase3-false-positive-secret',
    encryption
  }), { inserted: 1, updated: 0 });
  assert.deepEqual(importTransactions({
    database,
    accountId,
    transactions: [{
      ...common,
      status: 'BOOK',
      transaction_id: 'booked-b',
      entry_reference: 'booked-b-reference',
      remittance_information: ['Order B']
    }],
    hmacSecret: 'phase3-false-positive-secret',
    encryption
  }), { inserted: 1, updated: 0 });
  assert.equal(database.prepare('SELECT count(*) AS count FROM transactions').get()?.count, 2);
  const statuses = database.prepare(
    'SELECT status FROM transactions ORDER BY id'
  ).all() as Array<{ status: string }>;
  assert.deepEqual(statuses.map((row) => row.status), ['PDNG', 'BOOK']);
  database.close();
});

test('does not merge a booked transaction when multiple pending candidates match', () => {
  const { database, accountId, encryption } = transactionFixture();
  for (const key of ['pending-candidate-a', 'pending-candidate-b']) {
    database.prepare(`
      INSERT INTO transactions (
        account_id, provider_transaction_id, transaction_id, booking_date,
        amount_cents, currency, direction, counterparty_name, purpose, mcc,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PDNG', ?, ?)
    `).run(
      accountId,
      key,
      `${key}-provider-id`,
      '2026-01-06',
      1000,
      'EUR',
      'outgoing',
      'Same Merchant',
      'Same purpose',
      '5411',
      '2026-01-06T00:00:00.000Z',
      '2026-01-06T00:00:00.000Z'
    );
  }
  const booked = {
    status: 'BOOK',
    entry_reference: 'ambiguous-booked-reference',
    transaction_id: 'booked-provider-id',
    transaction_amount: { amount: '10.00', currency: 'EUR' },
    credit_debit_indicator: 'DBIT',
    booking_date: '2026-01-06',
    creditor: { name: 'Same Merchant' },
    creditor_account: { iban: 'DE89 3704 0044 0532 0130 00' },
    remittance_information: ['Same purpose'],
    merchant_category_code: '5411'
  };

  assert.deepEqual(importTransactions({
    database,
    accountId,
    transactions: [booked],
    hmacSecret: 'phase3-ambiguity-secret',
    encryption
  }), { inserted: 1, updated: 0 });
  assert.equal(database.prepare('SELECT count(*) AS count FROM transactions').get()?.count, 3);
  database.close();
});

test('keeps multiple same-day card payments distinct when entry references differ', () => {
  const { database, accountId, encryption } = transactionFixture();
  const base = {
    status: 'BOOK',
    transaction_amount: { amount: '4.99', currency: 'EUR' },
    credit_debit_indicator: 'DBIT',
    booking_date: '2026-01-07',
    creditor: { name: 'Card Merchant' },
    creditor_account: { iban: 'DE89 3704 0044 0532 0130 00' },
    merchant_category_code: '5812'
  };
  assert.deepEqual(importTransactions({
    database,
    accountId,
    transactions: [{
      ...base,
      transaction_id: 'card-1',
      entry_reference: 'card-entry-1',
      remittance_information: ['Card payment one']
    }, {
      ...base,
      transaction_id: 'card-2',
      entry_reference: 'card-entry-2',
      remittance_information: ['Card payment two']
    }],
    hmacSecret: 'phase3-card-secret',
    encryption
  }), { inserted: 2, updated: 0 });
  assert.equal(database.prepare('SELECT count(*) AS count FROM transactions').get()?.count, 2);
  database.close();
});

test('upgrades an unambiguous legacy fallback key', () => {
  const { database, accountId, encryption } = transactionFixture();
  const transaction = {
    status: 'BOOK',
    transaction_id: 'new-provider-id',
    entry_reference: 'new-entry-reference',
    transaction_amount: { amount: '18.00', currency: 'EUR' },
    credit_debit_indicator: 'DBIT',
    booking_date: '2026-01-08',
    creditor: { name: 'Legacy Merchant' },
    creditor_account: { iban: 'DE89 3704 0044 0532 0130 00' },
    remittance_information: ['Legacy migration'],
    merchant_category_code: '5999'
  };
  database.prepare(`
    INSERT INTO transactions (
      account_id, provider_transaction_id, transaction_id, booking_date,
      amount_cents, currency, direction, counterparty_name, purpose, mcc,
      status, created_at, updated_at
    ) VALUES (?, 'fallback-old-transaction-id', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    accountId,
    'old-provider-id',
    '2026-01-08',
    1800,
    'EUR',
    'outgoing',
    'Legacy Merchant',
    'Legacy migration',
    '5999',
    'BOOK',
    '2026-01-08T00:00:00.000Z',
    '2026-01-08T00:00:00.000Z'
  );

  assert.deepEqual(importTransactions({
    database,
    accountId,
    transactions: [transaction],
    hmacSecret: 'phase3-legacy-secret',
    encryption
  }), { inserted: 0, updated: 1 });
  assert.equal(database.prepare('SELECT count(*) AS count FROM transactions').get()?.count, 1);
  assert.equal(
    database.prepare('SELECT provider_transaction_id FROM transactions').get()?.provider_transaction_id,
    'new-entry-reference'
  );
  database.close();
});

test('normalizes fingerprint strings deterministically without locale-sensitive casing', () => {
  assert.equal(
    normalizeForFingerprint('  Ｅxample\t  Merchant  '),
    'Example Merchant'.toLowerCase()
  );
  assert.equal(
    normalizeForFingerprint('İSTANBUL'),
    'i̇stanbul'
  );
  assert.equal(normalizeForFingerprint('  A\nB\r\tC  '), 'a b c');
});

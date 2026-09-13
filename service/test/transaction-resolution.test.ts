import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { importTransactions } from '../src/enable-banking/importer.js';
import { migrateDatabase } from '../src/db/database.js';
import { createEncryptionService } from '../src/security/encryption.js';
import { captureProviderObservationsForAccount } from '../src/services/transaction-observations.js';
import { resolveTransactionsForAccount } from '../src/services/transaction-resolution.js';

const TEST_KEY = 'ab'.repeat(32);
const HMAC_SECRET = 'transaction-resolution-test-secret';

function fixture(): {
  database: DatabaseSync;
  encryption: ReturnType<typeof createEncryptionService>;
  sourceAccountId: number;
  targetAccountId: number;
  targetIban: string;
} {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  const encryption = createEncryptionService(TEST_KEY);
  database.prepare(`
    INSERT INTO enable_banking_connections (
      yuvomi_user_id, status, created_at, updated_at
    ) VALUES (1, 'authorized', ?, ?)
  `).run('2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z');
  const connectionId = Number(database.prepare(
    'SELECT id FROM enable_banking_connections LIMIT 1'
  ).get()?.id);
  const sourceIban = 'DE02120300000000202051';
  const targetIban = 'DE89370400440532013000';
  database.prepare(`
    INSERT INTO bank_accounts (
      connection_id, provider_account_id, display_name, alias, iban_encrypted,
      currency, created_at, updated_at
    ) VALUES (?, 'sparkasse-account', 'Sparkasse Giro', 'Hauptkonto', ?, 'EUR', ?, ?),
             (?, 'n26-account', 'N26', 'N26 Budget', ?, 'EUR', ?, ?)
  `).run(
    connectionId,
    encryption.encrypt(sourceIban),
    '2026-09-13T00:00:00.000Z',
    '2026-09-13T00:00:00.000Z',
    connectionId,
    encryption.encrypt(targetIban),
    '2026-09-13T00:00:00.000Z',
    '2026-09-13T00:00:00.000Z'
  );
  const accounts = database.prepare(
    'SELECT id, provider_account_id FROM bank_accounts ORDER BY id'
  ).all() as Array<{ id: number; provider_account_id: string }>;
  return {
    database,
    encryption,
    sourceAccountId: Number(accounts.find((row) => row.provider_account_id === 'sparkasse-account')?.id),
    targetAccountId: Number(accounts.find((row) => row.provider_account_id === 'n26-account')?.id),
    targetIban
  };
}

test('preserves a useful pending merchant descriptor when the booked counterparty becomes a settlement bank', () => {
  const { database, encryption, sourceAccountId } = fixture();
  const pending = {
    entry_reference: 'fresh-taste-card-payment',
    transaction_amount: { currency: 'EUR', amount: '17.39' },
    creditor: { name: 'MOL*FreshTaste 496224' },
    creditor_account: null,
    credit_debit_indicator: 'DBIT',
    status: 'PDNG',
    booking_date: '2026-09-12'
  };
  importTransactions({
    database,
    accountId: sourceAccountId,
    transactions: [pending],
    hmacSecret: HMAC_SECRET,
    encryption
  });
  captureProviderObservationsForAccount({
    database,
    accountId: sourceAccountId,
    transactions: [pending],
    now: new Date('2026-09-12T18:00:00.000Z')
  });

  const booked = {
    ...pending,
    creditor: { name: 'Landesbank Hessen-Thuringen' },
    status: 'BOOK',
    bank_transaction_code: {
      code: 'NDDT+106+9248+011',
      description: 'E-COM (APPLE PAY)'
    }
  };
  importTransactions({
    database,
    accountId: sourceAccountId,
    transactions: [booked],
    hmacSecret: HMAC_SECRET,
    encryption
  });
  captureProviderObservationsForAccount({
    database,
    accountId: sourceAccountId,
    transactions: [booked],
    now: new Date('2026-09-13T08:00:00.000Z')
  });

  const result = resolveTransactionsForAccount({
    database,
    accountId: sourceAccountId,
    encryption,
    hmacSecret: HMAC_SECRET,
    now: new Date('2026-09-13T08:01:00.000Z')
  });
  assert.equal(result.resolved, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM transactions').get()?.count, 1);
  assert.equal(database.prepare('SELECT merchant_name FROM transactions').get()?.merchant_name, 'FreshTaste');
  assert.deepEqual(
    { ...database.prepare(`
      SELECT entity_type, display_name, payment_method, intermediary_name, source
      FROM transaction_resolutions
    `).get() as Record<string, unknown> },
    {
      entity_type: 'merchant',
      display_name: 'FreshTaste',
      payment_method: 'Apple Pay',
      intermediary_name: 'Landesbank Hessen-Thuringen',
      source: 'observation.pending.counterparty_name'
    }
  );
  const statuses = database.prepare(
    'SELECT status FROM transaction_observations ORDER BY id'
  ).all().map((row) => row.status);
  assert.deepEqual(statuses, ['PDNG', 'BOOK']);
  database.close();
});

test('resolves the merchant from remittance text while keeping PayPal as intermediary context', () => {
  const { database, encryption, sourceAccountId } = fixture();
  const transaction = {
    entry_reference: 'paypal-google-payment',
    transaction_amount: { currency: 'EUR', amount: '9.99' },
    creditor: { name: 'PayPal Europe S.a.r.l. et Cie' },
    creditor_account: null,
    credit_debit_indicator: 'DBIT',
    status: 'BOOK',
    booking_date: '2026-09-13',
    remittance_information: [
      'Ihr Einkauf bei Google Payment Ireland Limited Referenz 123456789'
    ]
  };
  importTransactions({
    database,
    accountId: sourceAccountId,
    transactions: [transaction],
    hmacSecret: HMAC_SECRET,
    encryption
  });
  captureProviderObservationsForAccount({
    database,
    accountId: sourceAccountId,
    transactions: [transaction]
  });
  resolveTransactionsForAccount({
    database,
    accountId: sourceAccountId,
    encryption,
    hmacSecret: HMAC_SECRET
  });

  assert.equal(database.prepare('SELECT merchant_name FROM transactions').get()?.merchant_name, 'Google Payment');
  assert.deepEqual(
    { ...database.prepare(`
      SELECT display_name, intermediary_name, source FROM transaction_resolutions
    `).get() as Record<string, unknown> },
    {
      display_name: 'Google Payment',
      intermediary_name: 'PayPal',
      source: 'observation.booked.purpose'
    }
  );
  database.close();
});

test('recognizes transfers between the users own linked accounts from the local HMAC identity', () => {
  const { database, encryption, sourceAccountId, targetIban } = fixture();
  const transaction = {
    entry_reference: 'own-transfer',
    transaction_amount: { currency: 'EUR', amount: '412.20' },
    creditor: { name: 'Own N26 account' },
    creditor_account: { iban: targetIban },
    credit_debit_indicator: 'DBIT',
    status: 'BOOK',
    booking_date: '2026-09-13',
    remittance_information: ['Wochenbudget']
  };
  importTransactions({
    database,
    accountId: sourceAccountId,
    transactions: [transaction],
    hmacSecret: HMAC_SECRET,
    encryption
  });
  captureProviderObservationsForAccount({
    database,
    accountId: sourceAccountId,
    transactions: [transaction]
  });
  resolveTransactionsForAccount({
    database,
    accountId: sourceAccountId,
    encryption,
    hmacSecret: HMAC_SECRET
  });

  assert.equal(database.prepare('SELECT merchant_name FROM transactions').get()?.merchant_name, 'Umbuchung → N26 Budget');
  assert.deepEqual(
    { ...database.prepare(`
      SELECT entity_type, display_name, source FROM transaction_resolutions
    `).get() as Record<string, unknown> },
    {
      entity_type: 'own_transfer',
      display_name: 'Umbuchung → N26 Budget',
      source: 'own_account'
    }
  );
  database.close();
});

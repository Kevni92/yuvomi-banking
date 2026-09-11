import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { importTransactions } from '../src/enable-banking/importer.js';
import { migrateDatabase } from '../src/db/database.js';
import { createEncryptionService } from '../src/security/encryption.js';
import {
  backfillCounterpartyNamesFromProviderPayload,
  providerCounterpartyName
} from '../src/services/counterparty.js';
import {
  mergeDetailPayload,
  mergeListPayload,
  writeStoredProviderPayload
} from '../src/services/provider-transaction-payload.js';

const TEST_KEY = 'ef'.repeat(32);

function transactionFixture(): { database: DatabaseSync; accountId: number } {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  database.prepare(`
    INSERT INTO enable_banking_connections (
      yuvomi_user_id, status, created_at, updated_at
    ) VALUES (1, 'authorized', '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z')
  `).run();
  const connectionId = Number(database.prepare(
    'SELECT id FROM enable_banking_connections'
  ).get()?.id);
  database.prepare(`
    INSERT INTO bank_accounts (
      connection_id, provider_account_id, created_at, updated_at
    ) VALUES (?, 'provider-account-1', '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z')
  `).run(connectionId);
  return {
    database,
    accountId: Number(database.prepare('SELECT id FROM bank_accounts').get()?.id)
  };
}

test('stores direction-specific counterparty names without creating an IBAN identity', () => {
  const { database, accountId } = transactionFixture();
  const encryption = createEncryptionService(TEST_KEY);

  const result = importTransactions({
    database,
    accountId,
    hmacSecret: 'counterparty-name-test-secret',
    encryption,
    transactions: [{
      entry_reference: 'card-without-iban',
      transaction_amount: { currency: 'EUR', amount: '17.39' },
      creditor: { name: 'E-Kissel SBK Lambrecht' },
      creditor_account: null,
      credit_debit_indicator: 'DBIT',
      status: 'BOOK',
      booking_date: '2026-09-11',
      value_date: '2026-09-11',
      remittance_information: []
    }]
  });

  assert.deepEqual(result, { inserted: 1, updated: 0 });
  assert.deepEqual(
    { ...database.prepare('SELECT counterparty_name, counterparty_ref FROM transactions').get() as Record<string, unknown> },
    { counterparty_name: 'E-Kissel SBK Lambrecht', counterparty_ref: null }
  );
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM counterparties').get()?.count, 0);
  database.close();
});

test('uses debtor names for incoming transactions and leaves nameless transactions empty', () => {
  const { database, accountId } = transactionFixture();
  const encryption = createEncryptionService(TEST_KEY);

  importTransactions({
    database,
    accountId,
    hmacSecret: 'counterparty-direction-test-secret',
    encryption,
    transactions: [{
      entry_reference: 'income-without-iban',
      transaction_amount: { currency: 'EUR', amount: '25.00' },
      debtor: { name: 'Max Mustermann' },
      debtor_account: null,
      credit_debit_indicator: 'CRDT',
      status: 'BOOK',
      booking_date: '2026-09-11'
    }, {
      entry_reference: 'nameless-without-iban',
      transaction_amount: { currency: 'EUR', amount: '1.00' },
      debtor_account: null,
      credit_debit_indicator: 'CRDT',
      status: 'BOOK',
      booking_date: '2026-09-11'
    }]
  });

  const rows = database.prepare(
    'SELECT entry_reference, counterparty_name, counterparty_ref FROM transactions ORDER BY entry_reference'
  ).all().map((row) => ({ ...row })) as Array<Record<string, unknown>>;
  assert.deepEqual(rows, [
    { entry_reference: 'income-without-iban', counterparty_name: 'Max Mustermann', counterparty_ref: null },
    { entry_reference: 'nameless-without-iban', counterparty_name: null, counterparty_ref: null }
  ]);
  database.close();
});

test('fills and preserves counterparty names on later updates', () => {
  const { database, accountId } = transactionFixture();
  const encryption = createEncryptionService(TEST_KEY);
  const base = {
    entry_reference: 'name-update',
    transaction_amount: { currency: 'EUR', amount: '3.50' },
    creditor_account: null,
    credit_debit_indicator: 'DBIT',
    status: 'BOOK',
    booking_date: '2026-09-11'
  };

  importTransactions({
    database,
    accountId,
    hmacSecret: 'counterparty-update-test-secret',
    encryption,
    transactions: [{ ...base, creditor: {} }]
  });
  importTransactions({
    database,
    accountId,
    hmacSecret: 'counterparty-update-test-secret',
    encryption,
    transactions: [{ ...base, creditor: { name: 'First provider name' } }]
  });
  importTransactions({
    database,
    accountId,
    hmacSecret: 'counterparty-update-test-secret',
    encryption,
    transactions: [{ ...base, creditor: {} }]
  });

  assert.equal(database.prepare('SELECT counterparty_name FROM transactions').get()?.counterparty_name, 'First provider name');
  database.close();
});

test('backfills encrypted provider names without overwriting existing values', () => {
  const { database, accountId } = transactionFixture();
  const encryption = createEncryptionService(TEST_KEY);
  const listPayload = writeStoredProviderPayload(
    mergeListPayload(null, {
      creditor: { name: 'E-Kissel SBK Lambrecht' },
      credit_debit_indicator: 'DBIT'
    }, '2026-09-11T10:00:00.000Z'),
    encryption
  );
  const detailPayload = writeStoredProviderPayload(
    mergeDetailPayload(null, {
      debtor: { name: 'Max Mustermann' },
      credit_debit_indicator: 'CRDT'
    }, '2026-09-11T10:00:00.000Z'),
    encryption
  );
  database.prepare(`
    INSERT INTO transactions (
      account_id, provider_transaction_id, amount_cents, currency, direction,
      counterparty_name, raw_payload_encrypted, status, created_at, updated_at
    ) VALUES (?, 'legacy-outgoing', 1739, 'EUR', 'outgoing', NULL, ?, 'BOOK', ?, ?),
           (?, 'legacy-incoming', 2500, 'EUR', 'incoming', NULL, ?, 'BOOK', ?, ?),
           (?, 'already-known', 100, 'EUR', 'outgoing', 'Existing name', ?, 'BOOK', ?, ?)
  `).run(
    accountId, listPayload, '2026-09-11', '2026-09-11',
    accountId, detailPayload, '2026-09-11', '2026-09-11',
    accountId, listPayload, '2026-09-11', '2026-09-11'
  );

  assert.equal(backfillCounterpartyNamesFromProviderPayload({
    database,
    accountId,
    encryption,
    now: new Date('2026-09-11T12:00:00.000Z')
  }), 2);
  const rows = database.prepare(
    'SELECT provider_transaction_id, counterparty_name FROM transactions ORDER BY provider_transaction_id'
  ).all().map((row) => ({ ...row })) as Array<Record<string, unknown>>;
  assert.deepEqual(rows, [
    { provider_transaction_id: 'already-known', counterparty_name: 'Existing name' },
    { provider_transaction_id: 'legacy-incoming', counterparty_name: 'Max Mustermann' },
    { provider_transaction_id: 'legacy-outgoing', counterparty_name: 'E-Kissel SBK Lambrecht' }
  ]);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM counterparties').get()?.count, 0);
  database.close();
});

test('uses the counterparty name in fallback deduplication and reconciliation without an IBAN', () => {
  const { database, accountId } = transactionFixture();
  const encryption = createEncryptionService(TEST_KEY);
  const options = {
    database,
    accountId,
    hmacSecret: 'counterparty-fingerprint-test-secret',
    encryption
  };
  const base = {
    transaction_amount: { currency: 'EUR', amount: '10.00' },
    creditor_account: null,
    credit_debit_indicator: 'DBIT',
    booking_date: '2026-09-11',
    purpose: undefined
  };

  importTransactions({ ...options, transactions: [{
    ...base,
    transaction_id: 'without-iban-a',
    creditor: { name: 'Merchant A' },
    remittance_information: ['Same order']
  }] });
  importTransactions({ ...options, transactions: [{
    ...base,
    transaction_id: 'without-iban-b',
    creditor: { name: 'Merchant B' },
    remittance_information: ['Same order']
  }] });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM transactions').get()?.count, 2);

  importTransactions({ ...options, transactions: [{
    ...base,
    status: 'PDNG',
    transaction_id: 'pending-without-iban',
    creditor: { name: 'Recon Merchant' },
    remittance_information: ['Recon order']
  }] });
  importTransactions({ ...options, transactions: [{
    ...base,
    status: 'BOOK',
    transaction_id: 'booked-without-iban',
    entry_reference: 'booked-recon-reference',
    creditor: { name: 'Recon Merchant' },
    remittance_information: ['Recon order'],
    booking_date: '2026-09-12'
  }] });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM transactions').get()?.count, 3);
  assert.equal(database.prepare("SELECT status FROM transactions WHERE counterparty_name = 'Recon Merchant'").get()?.status, 'BOOK');
  database.close();
});

test('extracts only the direction-specific provider party', () => {
  assert.equal(providerCounterpartyName({ creditor: { name: 'Creditor' }, debtor: { name: 'Debtor' } }, 'outgoing'), 'Creditor');
  assert.equal(providerCounterpartyName({ creditor: { name: 'Creditor' }, debtor: { name: 'Debtor' } }, 'incoming'), 'Debtor');
  assert.equal(providerCounterpartyName({ creditor: { name: 'Creditor' } }, 'incoming'), null);
});

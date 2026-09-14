import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { importTransactions, type ProviderTransaction } from '../src/enable-banking/importer.js';
import { migrateDatabase } from '../src/db/database.js';
import { createEncryptionService } from '../src/security/encryption.js';
import { captureProviderObservationsForAccount } from '../src/services/transaction-observations.js';
import { resolveTransactionsForAccount } from '../src/services/transaction-resolution.js';
import { resolvePayeesForAccount } from '../src/services/payee-resolution.js';
import { listRecurringPayees } from '../src/services/recurring-payees.js';

const ENCRYPTION_KEY = 'cd'.repeat(32);
const HMAC_SECRET = 'payee-resolution-secret';
const NOW = new Date('2026-09-14T12:00:00.000Z');
const ENERGY_IBAN = 'DE89370400440532013000';

function fixture(): { database: DatabaseSync; encryption: ReturnType<typeof createEncryptionService>; accountId: number } {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  const encryption = createEncryptionService(ENCRYPTION_KEY);
  database.prepare(`INSERT INTO enable_banking_connections (id, yuvomi_user_id, status, created_at, updated_at) VALUES (1, 7, 'authorized', ?, ?), (2, 99, 'authorized', ?, ?)`)
    .run(NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), NOW.toISOString());
  database.prepare(`INSERT INTO bank_accounts (id, connection_id, provider_account_id, display_name, created_at, updated_at) VALUES (1, 1, 'owner', 'Household', ?, ?), (2, 2, 'other', 'Other', ?, ?)`)
    .run(NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), NOW.toISOString());
  return { database, encryption, accountId: 1 };
}

function transaction(entryReference: string, date: string, name: string, iban: string | null, extra: Record<string, unknown> = {}): ProviderTransaction {
  return {
    entry_reference: entryReference,
    transaction_amount: { amount: '12.34', currency: 'EUR' },
    creditor: { name },
    creditor_account: iban ? { iban } : null,
    credit_debit_indicator: 'DBIT', status: 'BOOK', booking_date: date,
    remittance_information: [`Payment ${entryReference}`], ...extra
  };
}

function resolve(database: DatabaseSync, encryption: ReturnType<typeof createEncryptionService>, accountId = 1) {
  resolveTransactionsForAccount({ database, accountId, encryption, hmacSecret: HMAC_SECRET, now: NOW });
  return resolvePayeesForAccount({ database, accountId, encryption, hmacSecret: HMAC_SECRET, now: NOW });
}

test('groups strong counterparties, keeps incoming and cash movements out, and is idempotent', () => {
  const { database, encryption, accountId } = fixture();
  try {
    const transactions = [
      transaction('energy-1', '2026-08-15', 'Example Energie', ENERGY_IBAN),
      transaction('energy-2', '2026-09-15', 'Example Energie GmbH', ENERGY_IBAN),
      transaction('gym-1', '2026-08-01', 'Studio Nord', null),
      transaction('gym-2', '2026-09-01', 'Studio Nord', null),
      transaction('cash-1', '2026-09-02', 'ATM', null, { bank_transaction_code: { description: 'Cash withdrawal' } }),
      { ...transaction('incoming-1', '2026-09-03', 'Example Energie', ENERGY_IBAN), credit_debit_indicator: 'CRDT', debtor: { name: 'Example Energie' }, debtor_account: { iban: ENERGY_IBAN }, creditor: null, creditor_account: null }
    ];
    importTransactions({ database, accountId, transactions, hmacSecret: HMAC_SECRET, encryption });
    captureProviderObservationsForAccount({ database, accountId, transactions, now: NOW });
    const first = resolve(database, encryption, accountId);
    const second = resolve(database, encryption, accountId);
    assert.equal(first.created, 2);
    assert.equal(second.created, 0);
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM payees`).get()?.count, 2);
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM transactions WHERE payee_match_state = 'excluded'`).get()?.count, 2);
    const recurring = listRecurringPayees(database, { ownerId: 7, limit: 50, offset: 0 });
    assert.equal(recurring.total, 2);
    const strongPayee = recurring.payees.find((payee) => payee.identity_quality === 'strong');
    const candidatePayee = recurring.payees.find((payee) => payee.status === 'candidate');
    assert.equal(strongPayee?.booked_transaction_count, 2);
    assert.equal(candidatePayee?.booked_transaction_count, 2);
    assert.equal(candidatePayee?.status, 'candidate');
  } finally {
    database.close();
  }
});

test('does not create a PayPal payee without an underlying merchant resolution', () => {
  const { database, encryption, accountId } = fixture();
  try {
    const paypal = [
      transaction('paypal-1', '2026-08-10', 'PayPal Europe', null),
      transaction('paypal-2', '2026-09-10', 'PayPal Europe', null)
    ];
    importTransactions({ database, accountId, transactions: paypal, hmacSecret: HMAC_SECRET, encryption });
    resolve(database, encryption, accountId);
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM payees`).get()?.count, 0);
  } finally {
    database.close();
  }
});

test('keeps conflicting strong identifiers ambiguous', () => {
  const { database, encryption, accountId } = fixture();
  try {
    const first = transaction('first', '2026-08-10', 'First Company', ENERGY_IBAN, { sepa_creditor_id: 'DE98ZZZ00000012345' });
    const secondIban = 'DE02120300000000202051';
    const second = transaction('second', '2026-08-11', 'Second Company', secondIban, { sepa_creditor_id: 'DE97ZZZ00000054321' });
    importTransactions({ database, accountId, transactions: [first, second], hmacSecret: HMAC_SECRET, encryption });
    resolve(database, encryption, accountId);
    // A later transaction carries both previously claimed strong identities.
    const conflict = transaction('conflict', '2026-09-10', 'Conflict', secondIban, { sepa_creditor_id: 'DE98ZZZ00000012345' });
    importTransactions({ database, accountId, transactions: [conflict], hmacSecret: HMAC_SECRET, encryption });
    resolve(database, encryption, accountId);
    const state = database.prepare(`SELECT payee_match_state FROM transactions WHERE entry_reference = 'conflict'`).get() as { payee_match_state: string };
    assert.equal(state.payee_match_state, 'ambiguous');
  } finally {
    database.close();
  }
});

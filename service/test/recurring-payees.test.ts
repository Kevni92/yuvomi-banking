import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateDatabase } from '../src/db/database.js';
import {
  clearPayeeCategory,
  listRecurringPayees,
  PayeeCategoryConflictError,
  setPayeeCategory
} from '../src/services/recurring-payees.js';

const NOW = new Date('2026-09-14T12:00:00.000Z');

function fixture(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  database.exec(`
    INSERT INTO enable_banking_connections (id, yuvomi_user_id, status, created_at, updated_at)
      VALUES (1, 7, 'authorized', '2026-01-01', '2026-01-01');
    INSERT INTO bank_accounts (id, connection_id, provider_account_id, display_name, currency, created_at, updated_at)
      VALUES (1, 1, 'owner', 'Household', 'EUR', '2026-01-01', '2026-01-01');
    INSERT INTO categories (id, name, type, active, created_at, updated_at)
      VALUES (1, 'Household', 'expense', 1, '2026-01-01', '2026-01-01'),
             (2, 'Manual exception', 'expense', 1, '2026-01-01', '2026-01-01'),
             (3, 'Income category', 'income', 1, '2026-01-01', '2026-01-01'),
             (4, 'Disabled', 'expense', 0, '2026-01-01', '2026-01-01');
    INSERT INTO payees (id, yuvomi_user_id, display_name, display_name_source, status, created_at, updated_at)
      VALUES (1, 7, 'Example Utilities', 'provider.creditor_name', 'confirmed', '2026-01-01', '2026-01-01'),
             (2, 7, 'One-off', 'provider.creditor_name', 'confirmed', '2026-01-01', '2026-01-01'),
             (3, 99, 'Private Payee', 'provider.creditor_name', 'confirmed', '2026-01-01', '2026-01-01');
  `);
  const insert = database.prepare(`
    INSERT INTO transactions (
      account_id, provider_transaction_id, booking_date, amount_cents, currency,
      direction, status, payee_id, payee_match_state, category_id, category_source,
      category_confidence, created_at, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, 'matched', ?, ?, ?, '2026-01-01', '2026-01-01')
  `);
  insert.run('booked-eur-1', '2026-08-01', 1200, 'EUR', 'outgoing', 'BOOK', 1, null, null, null);
  insert.run('booked-eur-2', '2026-09-01', 1300, 'EUR', 'outgoing', 'BOOK', 1, 2, 'manual', 1);
  insert.run('booked-usd', '2026-09-05', 1400, 'USD', 'outgoing', 'BOOK', 1, null, null, null);
  insert.run('pending-eur', null, 1500, 'EUR', 'outgoing', 'PDNG', 1, null, null, null);
  insert.run('incoming', '2026-09-06', 5000, 'EUR', 'incoming', 'BOOK', 1, null, null, null);
  insert.run('one-off', '2026-09-06', 700, 'EUR', 'outgoing', 'BOOK', 2, null, null, null);
  return database;
}

test('aggregates only recurring booked outgoing transactions and exposes currency exceptions', () => {
  const database = fixture();
  try {
    const result = listRecurringPayees(database, { ownerId: 7, limit: 50, offset: 0 });
    assert.equal(result.total, 1);
    assert.equal(result.payees[0].booked_transaction_count, 3);
    assert.equal(result.payees[0].pending_transaction_count, 1);
    assert.equal(result.payees[0].account_count, 1);
    assert.equal(result.payees[0].currency, null);
    assert.equal(result.payees[0].last_amount, null);
    assert.equal(result.payees[0].manual_exception_count, 1);
    assert.equal(listRecurringPayees(database, { ownerId: 7, payeeId: 1, recurring: false, limit: 1, offset: 0 }).total, 1);
    assert.equal(listRecurringPayees(database, { ownerId: 99, recurring: false, limit: 50, offset: 0 }).total, 0);
  } finally {
    database.close();
  }
});

test('payee category wins locally, preserves manual exceptions, and can be cleared', () => {
  const database = fixture();
  try {
    database.prepare(`
      INSERT INTO ai_categorization_reviews (transaction_id, category_id, confidence, reason, status, created_at, updated_at)
      VALUES (1, 1, 0.5, 'Needs review', 'pending', '2026-01-01', '2026-01-01')
    `).run();
    const set = setPayeeCategory(database, { ownerId: 7, payeeId: 1, categoryId: 1, now: NOW });
    assert.equal(set.affected_transactions, 4);
    assert.equal(set.manual_exceptions, 1);
    assert.equal(set.resolved_ai_reviews, 1);
    assert.deepEqual(database.prepare(`
      SELECT id, category_id, category_source, category_origin_payee_id
        FROM transactions WHERE payee_id = 1 ORDER BY id
    `).all().map((row) => ({ ...row })), [
      { id: 1, category_id: 1, category_source: 'counterparty_rule', category_origin_payee_id: 1 },
      { id: 2, category_id: 2, category_source: 'manual', category_origin_payee_id: null },
      { id: 3, category_id: 1, category_source: 'counterparty_rule', category_origin_payee_id: 1 },
      { id: 4, category_id: 1, category_source: 'counterparty_rule', category_origin_payee_id: 1 },
      { id: 5, category_id: 1, category_source: 'counterparty_rule', category_origin_payee_id: 1 }
    ]);
    assert.throws(
      () => setPayeeCategory(database, { ownerId: 7, payeeId: 1, categoryId: 3, now: NOW }),
      PayeeCategoryConflictError
    );
    assert.throws(
      () => setPayeeCategory(database, { ownerId: 7, payeeId: 1, categoryId: 4, now: NOW }),
      PayeeCategoryConflictError
    );
    const cleared = clearPayeeCategory(database, { ownerId: 7, payeeId: 1, now: NOW });
    assert.equal(cleared.category_id, null);
    assert.equal(cleared.manual_exceptions, 1);
    assert.deepEqual(database.prepare(`
      SELECT id, category_id, category_source, category_origin_payee_id
        FROM transactions WHERE payee_id = 1 ORDER BY id
    `).all().map((row) => ({ ...row })), [
      { id: 1, category_id: null, category_source: null, category_origin_payee_id: null },
      { id: 2, category_id: 2, category_source: 'manual', category_origin_payee_id: null },
      { id: 3, category_id: null, category_source: null, category_origin_payee_id: null },
      { id: 4, category_id: null, category_source: null, category_origin_payee_id: null },
      { id: 5, category_id: null, category_source: null, category_origin_payee_id: null }
    ]);
  } finally {
    database.close();
  }
});

test('candidate recognition needs explicit confirmation before assigning a category', () => {
  const database = fixture();
  try {
    database.prepare(`UPDATE payees SET status = 'candidate' WHERE id = 1`).run();
    assert.throws(
      () => setPayeeCategory(database, { ownerId: 7, payeeId: 1, categoryId: 1, now: NOW }),
      PayeeCategoryConflictError
    );
    const result = setPayeeCategory(database, {
      ownerId: 7, payeeId: 1, categoryId: 1, confirmCandidate: true, now: NOW
    });
    assert.equal(result.status, 'confirmed');
  } finally {
    database.close();
  }
});

test('payee aggregation keeps the booked lookup index available for large accounts', () => {
  const database = fixture();
  try {
    const insert = database.prepare(`
      INSERT INTO transactions (
        account_id, provider_transaction_id, booking_date, amount_cents, currency,
        direction, status, payee_id, payee_match_state, created_at, updated_at
      ) VALUES (1, ?, '2026-09-14', 100, 'EUR', 'outgoing', 'BOOK', 1, 'matched', '2026-01-01', '2026-01-01')
    `);
    database.exec('BEGIN;');
    for (let index = 0; index < 10_000; index += 1) insert.run(`bulk-${index}`);
    database.exec('COMMIT;');
    const plan = database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT COUNT(*) FROM transactions
       WHERE payee_id = 1 AND direction = 'outgoing' AND status = 'BOOK'
    `).all().map((row) => String((row as { detail?: unknown }).detail ?? '')).join(' ');
    assert.match(plan, /idx_transactions_payee_booked/);
  } finally {
    database.close();
  }
});

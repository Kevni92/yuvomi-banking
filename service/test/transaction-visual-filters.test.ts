import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateDatabase } from '../src/db/database.js';
import { parseTransactionQuery, queryTransactions } from '../src/services/transactions-query.js';

const NOW = '2026-09-12T08:00:00.000Z';

function fixture(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrateDatabase(db);
  db.prepare(`INSERT INTO enable_banking_connections (yuvomi_user_id, status, created_at, updated_at) VALUES (7, 'authorized', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO bank_accounts (connection_id, provider_account_id, display_name, alias, color_hex, currency, created_at, updated_at) VALUES (1, 'acc', 'Provider Konto', 'Haushalt', '#2563EB', 'EUR', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO categories (name, type, active, weekly_budget_default, icon_key, color_hex, created_at, updated_at) VALUES ('Lebensmittel', 'expense', 1, 1, 'shopping-cart', '#16A34A', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO categories (name, type, active, weekly_budget_default, icon_key, color_hex, created_at, updated_at) VALUES ('Shopping', 'expense', 1, 0, 'shopping-bag', '#7C3AED', ?, ?)`).run(NOW, NOW);
  const insert = db.prepare(`INSERT INTO transactions (account_id, provider_transaction_id, booking_date, amount_cents, currency, direction, status, category_id, weekly_budget_override, created_at, updated_at) VALUES (1, ?, '2026-09-12', ?, 'EUR', 'outgoing', 'BOOK', ?, ?, ?, ?)`);
  insert.run('t1', 1000, 1, 'inherit', NOW, NOW);
  insert.run('t2', 2000, 2, 'include', NOW, NOW);
  insert.run('t3', 3000, 2, 'inherit', NOW, NOW);
  insert.run('t4', 4000, 1, 'exclude', NOW, NOW);
  return db;
}

test('transaction query exposes visual metadata and resolves weekly-budget selection', () => {
  const db = fixture();
  try {
    const result = queryTransactions(db, {
      userId: 7, sort: 'date', order: 'desc', limit: 25, offset: 0
    });
    assert.equal(result.total, 4);
    const first = result.transactions.find((row) => row.id === 1);
    assert.equal(first?.account_alias, 'Haushalt');
    assert.equal(first?.account_color, '#2563EB');
    assert.equal(first?.category_icon, 'shopping-cart');
    assert.equal(first?.category_color, '#16A34A');
    assert.equal(first?.weekly_budget_selected, 1);
    assert.equal(result.transactions.find((row) => row.id === 3)?.weekly_budget_selected, 0);
    assert.equal(result.transactions.find((row) => row.id === 4)?.weekly_budget_selected, 0);
  } finally { db.close(); }
});

test('transaction query accepts multiple categories and weekly-budget-only filtering', () => {
  const db = fixture();
  try {
    const parsed = parseTransactionQuery(7, {
      category_id: '1,2,2', weekly_budget: '1', sort: 'amount', order: 'asc', limit: '25', offset: '0'
    });
    assert.deepEqual(parsed.categoryIds, [1, 2]);
    assert.equal(parsed.weeklyBudgetOnly, true);
    const result = queryTransactions(db, parsed);
    assert.deepEqual(result.transactions.map((row) => row.id), [1, 2]);
  } finally { db.close(); }
});

import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateDatabase } from '../src/db/database.js';
import {
  CategoryConflictError,
  CategoryValidationError,
  createCategory,
  updateCategory
} from '../src/services/categories.js';

const NOW = new Date('2026-09-11T10:00:00.000Z');
function fixture(): DatabaseSync { const db = new DatabaseSync(':memory:'); migrateDatabase(db); return db; }

test('categories are normalized, unique, and retain transaction references when deactivated', () => {
  const database = fixture();
  try {
    const category = createCategory(database, {
      name: '  Lebens\u0000   mittel  ', type: 'expense', weeklyBudgetDefault: true, now: NOW
    });
    assert.equal(category.name, 'Lebens mittel');
    assert.equal(category.weeklyBudgetDefault, true);
    assert.throws(() => createCategory(database, {
      name: 'lebens mittel', type: 'expense', now: NOW
    }), CategoryConflictError);
    assert.throws(() => createCategory(database, {
      name: '', type: 'expense', now: NOW
    }), CategoryValidationError);
    assert.throws(() => createCategory(database, {
      name: 'Bad', type: 'other', now: NOW
    }), CategoryValidationError);
    assert.equal(createCategory(database, {
      name: 'Income', type: 'income', weeklyBudgetDefault: true, now: NOW
    }).weeklyBudgetDefault, false);
    const archived = createCategory(database, { name: 'Archiv', type: 'expense', now: NOW });
    updateCategory(database, archived.id, { active: false, now: NOW });
    assert.throws(() => createCategory(database, { name: 'archiv', type: 'expense', now: NOW }), CategoryConflictError);
    database.prepare(`INSERT INTO enable_banking_connections (yuvomi_user_id, status, created_at, updated_at) VALUES (7, 'authorized', ?, ?)`)
      .run(NOW.toISOString(), NOW.toISOString());
    database.prepare(`INSERT INTO bank_accounts (connection_id, provider_account_id, created_at, updated_at) VALUES (1, 'account', ?, ?)`)
      .run(NOW.toISOString(), NOW.toISOString());
    database.prepare(`INSERT INTO transactions (account_id, provider_transaction_id, amount_cents, currency, direction, status, category_id, created_at, updated_at) VALUES (1, 'transaction', 100, 'EUR', 'outgoing', 'BOOK', ?, ?, ?)`)
      .run(category.id, NOW.toISOString(), NOW.toISOString());
    const inactive = updateCategory(database, category.id, { active: false, now: NOW });
    assert.equal(inactive.active, false);
    assert.equal(database.prepare('SELECT category_id FROM transactions WHERE id = 1').get()?.category_id, category.id);
    assert.equal(updateCategory(database, category.id, { active: true, name: 'Groceries', now: NOW }).name, 'Groceries');
  } finally { database.close(); }
});

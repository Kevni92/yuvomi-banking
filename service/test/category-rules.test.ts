import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateDatabase } from '../src/db/database.js';
import {
  CategoryAssignmentNotFoundError,
  applyCategoryRulesForAccount,
  assignManualTransactionCategory
} from '../src/services/category-rules.js';

const NOW = new Date('2026-09-18T12:00:00.000Z');
const LIDL_COUNTERPARTY = 'hmac-lidl-not-an-iban';

function fixture(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  database.prepare(`
    INSERT INTO enable_banking_connections (yuvomi_user_id, status, created_at, updated_at)
    VALUES (7, 'authorized', ?, ?), (99, 'authorized', ?, ?)
  `).run(
    NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), NOW.toISOString()
  );
  database.prepare(`
    INSERT INTO bank_accounts (connection_id, provider_account_id, created_at, updated_at)
    VALUES (1, 'owner-account', ?, ?), (2, 'other-account', ?, ?)
  `).run(
    NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), NOW.toISOString()
  );
  database.prepare(`
    INSERT INTO categories (name, type, created_at, updated_at)
    VALUES ('Lebensmittel', 'expense', ?, ?), ('Freizeit', 'expense', ?, ?)
  `).run(
    NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), NOW.toISOString()
  );
  database.prepare(`
    INSERT INTO counterparties (counterparty_id, display_name, created_at, updated_at)
    VALUES (?, 'LIDL', ?, ?)
  `).run(LIDL_COUNTERPARTY, NOW.toISOString(), NOW.toISOString());
  database.prepare(`
    INSERT INTO transactions (
      account_id, provider_transaction_id, amount_cents, currency, direction,
      counterparty_ref, status, created_at, updated_at
    ) VALUES
      (1, 'owner-lidl-1', 1234, 'EUR', 'outgoing', 1, 'BOOK', ?, ?),
      (1, 'owner-lidl-2', 2345, 'EUR', 'outgoing', 1, 'BOOK', ?, ?),
      (1, 'owner-manual', 3456, 'EUR', 'outgoing', 1, 'BOOK', ?, ?),
      (2, 'other-lidl', 4567, 'EUR', 'outgoing', 1, 'BOOK', ?, ?)
  `).run(
    NOW.toISOString(), NOW.toISOString(),
    NOW.toISOString(), NOW.toISOString(),
    NOW.toISOString(), NOW.toISOString(),
    NOW.toISOString(), NOW.toISOString()
  );
  database.prepare(`
    UPDATE transactions SET category_id = 2, category_source = 'manual', category_confidence = 1
    WHERE id = 3
  `).run();
  return database;
}

test('a manual category assignment learns a user-scoped counterparty rule', () => {
  const database = fixture();
  try {
    assert.deepEqual(assignManualTransactionCategory(database, {
      yuvomiUserId: 7,
      transactionId: 1,
      categoryId: 1,
      now: NOW
    }), {
      transactionId: 1,
      categoryId: 1,
      ruleCreated: true,
      affectedTransactions: 2
    });
    assert.deepEqual(
      database.prepare(`
        SELECT id, category_id, category_source FROM transactions ORDER BY id
      `).all().map((row) => ({ ...row })),
      [
        { id: 1, category_id: 1, category_source: 'manual' },
        { id: 2, category_id: 1, category_source: 'counterparty_rule' },
        { id: 3, category_id: 2, category_source: 'manual' },
        { id: 4, category_id: null, category_source: null }
      ]
    );
    assert.deepEqual({ ...(database.prepare(`
      SELECT yuvomi_user_id, rule_type, match_value, category_id, source
      FROM category_rules
    `).get() as Record<string, unknown>) }, {
      yuvomi_user_id: 7,
      rule_type: 'counterparty',
      match_value: LIDL_COUNTERPARTY,
      category_id: 1,
      source: 'manual'
    });
  } finally {
    database.close();
  }
});

test('rules are reapplied on later imports without replacing a manual category', () => {
  const database = fixture();
  try {
    assignManualTransactionCategory(database, {
      yuvomiUserId: 7,
      transactionId: 1,
      categoryId: 1,
      now: NOW
    });
    database.prepare(`
      UPDATE transactions SET category_id = NULL, category_source = NULL, category_confidence = NULL
      WHERE id = 2
    `).run();
    assert.equal(applyCategoryRulesForAccount(database, 1, NOW), 1);
    assert.deepEqual({ ...(database.prepare(`
      SELECT category_id, category_source FROM transactions WHERE id = 2
    `).get() as Record<string, unknown>) }, {
      category_id: 1,
      category_source: 'counterparty_rule'
    });
    assert.deepEqual({ ...(database.prepare(`
      SELECT category_id, category_source FROM transactions WHERE id = 3
    `).get() as Record<string, unknown>) }, {
      category_id: 2,
      category_source: 'manual'
    });
  } finally {
    database.close();
  }
});

test('a manual category assignment resolves its pending AI review', () => {
  const database = fixture();
  try {
    database.prepare(`
      INSERT INTO ai_categorization_reviews (
        transaction_id, category_id, confidence, reason, status, created_at, updated_at
      ) VALUES (1, 1, 0.5, 'Needs review', 'pending', ?, ?)
    `).run(NOW.toISOString(), NOW.toISOString());
    assignManualTransactionCategory(database, {
      yuvomiUserId: 7,
      transactionId: 1,
      categoryId: 1,
      now: NOW
    });
    assert.deepEqual({ ...(database.prepare(`
      SELECT status, resolved_at FROM ai_categorization_reviews WHERE transaction_id = 1
    `).get() as Record<string, unknown>) }, {
      status: 'applied',
      resolved_at: NOW.toISOString()
    });
  } finally {
    database.close();
  }
});

test('a category assignment cannot reach another users transaction', () => {
  const database = fixture();
  try {
    assert.throws(
      () => assignManualTransactionCategory(database, {
        yuvomiUserId: 7,
        transactionId: 4,
        categoryId: 1,
        now: NOW
      }),
      CategoryAssignmentNotFoundError
    );
  } finally {
    database.close();
  }
});

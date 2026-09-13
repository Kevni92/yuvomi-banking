import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateDatabase } from '../src/db/database.js';
import { applyCategoryRulesForAccount } from '../src/services/category-rules.js';

const NOW = new Date('2026-09-13T08:00:00.000Z');

test('cash withdrawals use an existing Bargeld category without AI', () => {
  const database = new DatabaseSync(':memory:');
  try {
    migrateDatabase(database);
    database.prepare(`
      INSERT INTO enable_banking_connections (yuvomi_user_id, status, created_at, updated_at)
      VALUES (7, 'authorized', ?, ?)
    `).run(NOW.toISOString(), NOW.toISOString());
    database.prepare(`
      INSERT INTO bank_accounts (connection_id, provider_account_id, created_at, updated_at)
      VALUES (1, 'sparkasse', ?, ?)
    `).run(NOW.toISOString(), NOW.toISOString());
    database.prepare(`
      INSERT INTO categories (name, type, created_at, updated_at)
      VALUES ('Bargeld', 'expense', ?, ?)
    `).run(NOW.toISOString(), NOW.toISOString());
    database.prepare(`
      INSERT INTO transactions (
        account_id, provider_transaction_id, booking_date, amount_cents, currency,
        direction, purpose, status, bank_transaction_code, created_at, updated_at
      ) VALUES (1, 'cash-1', '2026-09-10', 4000, 'EUR', 'outgoing',
        '10.09/14.38UHR LAMBRECHT', 'BOOK', ?, ?, ?)
    `).run(
      JSON.stringify({ description: 'BARGELDAUSZAHLUNG', code: 'NMSC+083+2239+003', sub_code: null }),
      NOW.toISOString(), NOW.toISOString()
    );

    assert.equal(applyCategoryRulesForAccount(database, 1, NOW), 1);
    assert.deepEqual({ ...(database.prepare(`
      SELECT category_id, category_source, category_confidence FROM transactions WHERE provider_transaction_id = 'cash-1'
    `).get() as Record<string, unknown>) }, {
      category_id: 1,
      category_source: 'text_rule',
      category_confidence: 1
    });
  } finally {
    database.close();
  }
});

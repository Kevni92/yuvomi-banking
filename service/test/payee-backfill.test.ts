import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { backfillPayees } from '../src/cli/payee-backfill.js';
import { migrateDatabase } from '../src/db/database.js';
import { createEncryptionService } from '../src/security/encryption.js';

const KEY = 'ef'.repeat(32);

function fixture(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  database.exec(`
    INSERT INTO enable_banking_connections (id, yuvomi_user_id, status, created_at, updated_at)
      VALUES (1, 7, 'authorized', '2026-01-01', '2026-01-01');
    INSERT INTO bank_accounts (id, connection_id, provider_account_id, display_name, created_at, updated_at)
      VALUES (1, 1, 'owner', 'Household', '2026-01-01', '2026-01-01');
    INSERT INTO categories (id, name, type, active, created_at, updated_at)
      VALUES (1, 'Utilities', 'expense', 1, '2026-01-01', '2026-01-01');
    INSERT INTO counterparties (id, counterparty_id, display_name, created_at, updated_at)
      VALUES (1, 'legacy-utilities', 'Example Utilities', '2026-01-01', '2026-01-01');
    INSERT INTO transactions (
      account_id, provider_transaction_id, booking_date, amount_cents, currency,
      direction, counterparty_ref, status, created_at, updated_at
    ) VALUES
      (1, 'one', '2026-08-01', 1200, 'EUR', 'outgoing', 1, 'BOOK', '2026-01-01', '2026-01-01'),
      (1, 'two', '2026-09-01', 1300, 'EUR', 'outgoing', 1, 'BOOK', '2026-01-01', '2026-01-01');
    INSERT INTO category_rules (
      yuvomi_user_id, rule_type, match_value, category_id, priority, source, enabled, created_at, updated_at
    ) VALUES (7, 'counterparty', 'legacy-utilities', 1, 0, 'manual', 1, '2026-01-01', '2026-01-01');
  `);
  return database;
}

test('payee backfill is a safe dry-run and adopts an unambiguous legacy rule on apply', () => {
  const database = fixture();
  try {
    const encryption = createEncryptionService(KEY);
    const dryRun = backfillPayees({
      database, encryption, hmacSecret: 'backfill-secret',
      now: new Date('2026-09-14T12:00:00.000Z')
    });
    assert.equal(dryRun.created, 1);
    assert.equal(dryRun.legacy_rules_adopted, 1);
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM payees`).get()?.count, 0);

    const applied = backfillPayees({
      database, encryption, hmacSecret: 'backfill-secret', apply: true,
      now: new Date('2026-09-14T12:00:00.000Z')
    });
    assert.equal(applied.created, 1);
    assert.equal(applied.legacy_rules_adopted, 1);
    assert.deepEqual({ ...(database.prepare(`
      SELECT payees.status, payees.category_id, transactions.category_source,
             transactions.category_origin_payee_id
        FROM payees JOIN transactions ON transactions.payee_id = payees.id
       LIMIT 1
    `).get() as Record<string, unknown>) }, {
      status: 'confirmed', category_id: 1,
      category_source: 'counterparty_rule', category_origin_payee_id: 1
    });
    const repeat = backfillPayees({
      database, encryption, hmacSecret: 'backfill-secret', apply: true,
      now: new Date('2026-09-14T12:00:00.000Z')
    });
    assert.equal(repeat.created, 0);
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM payees`).get()?.count, 1);
  } finally {
    database.close();
  }
});

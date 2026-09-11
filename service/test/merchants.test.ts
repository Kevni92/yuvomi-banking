import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateDatabase } from '../src/db/database.js';
import { normalizeMerchant, normalizeMerchantsForAccount } from '../src/services/merchants.js';

const NOW = new Date('2026-09-21T10:00:00.000Z');

test('normalizes known merchant variants without treating unknown people as merchants', () => {
  assert.deepEqual(normalizeMerchant('Kartenzahlung Lidl Filiale 123'), {
    key: 'lidl', name: 'Lidl'
  });
  assert.deepEqual(normalizeMerchant('dm-drogerie markt Berlin'), {
    key: 'dm', name: 'dm'
  });
  assert.equal(normalizeMerchant('Transfer to Max Mustermann'), null);
});

test('normalizes only registry matches for an account', () => {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  try {
    database.prepare(`
      INSERT INTO enable_banking_connections (yuvomi_user_id, status, created_at, updated_at)
      VALUES (7, 'authorized', ?, ?)
    `).run(NOW.toISOString(), NOW.toISOString());
    database.prepare(`
      INSERT INTO bank_accounts (connection_id, provider_account_id, created_at, updated_at)
      VALUES (1, 'merchant-test-account', ?, ?)
    `).run(NOW.toISOString(), NOW.toISOString());
    database.prepare(`
      INSERT INTO transactions (
        account_id, provider_transaction_id, amount_cents, currency, direction,
        counterparty_name, purpose, status, created_at, updated_at
      ) VALUES
        (1, 'lidl', 1200, 'EUR', 'outgoing', 'LIDL #123', 'Card payment', 'BOOK', ?, ?),
        (1, 'person', 1200, 'EUR', 'outgoing', 'Max Mustermann', 'Gift', 'BOOK', ?, ?)
    `).run(
      NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), NOW.toISOString()
    );
    assert.equal(normalizeMerchantsForAccount(database, 1, NOW), 1);
    assert.deepEqual({ ...(database.prepare(
      'SELECT merchant_key, merchant_name FROM transactions WHERE id = 1'
    ).get() as Record<string, unknown>) },
      { merchant_key: 'lidl', merchant_name: 'Lidl' }
    );
    assert.deepEqual({ ...(database.prepare(
      'SELECT merchant_key, merchant_name FROM transactions WHERE id = 2'
    ).get() as Record<string, unknown>) },
      { merchant_key: null, merchant_name: null }
    );
  } finally {
    database.close();
  }
});

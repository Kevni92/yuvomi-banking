import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { CategorizationClient } from '../src/openai/categorizer.js';
import { redactCategorizationText } from '../src/openai/categorizer.js';
import { migrateDatabase } from '../src/db/database.js';
import { AUTO_APPLY_CONFIDENCE, categorizeUnresolvedTransactions } from '../src/services/transaction-categorization.js';
import { acceptCategorySuggestion } from '../src/services/category-suggestions.js';

const NOW = new Date('2026-09-19T09:00:00.000Z');
const RAW_IBAN = 'DE89370400440532013000';

function fixture(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  database.prepare(`
    INSERT INTO enable_banking_connections (yuvomi_user_id, status, created_at, updated_at)
    VALUES (7, 'authorized', ?, ?)
  `).run(NOW.toISOString(), NOW.toISOString());
  database.prepare(`
    INSERT INTO bank_accounts (connection_id, provider_account_id, created_at, updated_at)
    VALUES (1, 'categorization-account', ?, ?)
  `).run(NOW.toISOString(), NOW.toISOString());
  database.prepare(`
    INSERT INTO categories (name, type, created_at, updated_at)
    VALUES ('Lebensmittel', 'expense', ?, ?), ('Mobilität', 'expense', ?, ?)
  `).run(
    NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), NOW.toISOString()
  );
  database.prepare(`
    INSERT INTO counterparties (counterparty_id, display_name, iban_encrypted, created_at, updated_at)
    VALUES ('hmac-recipient', 'Private Recipient', 'encrypted-local-only', ?, ?)
  `).run(NOW.toISOString(), NOW.toISOString());
  database.prepare(`
    INSERT INTO transactions (
      account_id, provider_transaction_id, amount_cents, currency, direction,
      counterparty_ref, counterparty_name, purpose, status, created_at, updated_at
    ) VALUES
      (1, 'categorize-1', 1234, 'EUR', 'outgoing', 1, 'Private Recipient',
       ?, 'BOOK', ?, ?),
      (1, 'categorize-2', 4567, 'EUR', 'outgoing', 1, 'Private Recipient',
       'Taxi ride', 'BOOK', ?, ?),
      (1, 'categorize-3', 890, 'EUR', 'outgoing', 1, 'Private Recipient',
       'Unknown payment', 'BOOK', ?, ?)
  `).run(
    `Invoice ${RAW_IBAN} jane.doe@example.com +49 151 12345678`, NOW.toISOString(), NOW.toISOString(),
    NOW.toISOString(), NOW.toISOString(),
    NOW.toISOString(), NOW.toISOString()
  );
  return database;
}

test('redacts common private text before a transaction reaches OpenAI', () => {
  const redacted = redactCategorizationText(
    `Contact jane.doe@example.com, ${RAW_IBAN}, +49 151 12345678`
  );
  assert.ok(redacted);
  assert.doesNotMatch(redacted, /DE893704|jane\.doe|151 12345678/i);
  assert.match(redacted, /\[iban\]/);
  assert.match(redacted, /\[email\]/);
  assert.match(redacted, /\[number\]/);
});

test('categorizes only the allowlist and leaves low-confidence results for review', async () => {
  const database = fixture();
  let received: unknown;
  const categorizer: CategorizationClient = {
    categorize: async (input) => {
      received = input;
      return [
        {
          transaction_id: 1,
          category_id: 1,
          confidence: 0.96,
          reason: 'Grocery purchase',
          suggested_category: null
        },
        {
          transaction_id: 2,
          category_id: 2,
          confidence: 0.55,
          reason: 'Likely transport',
          suggested_category: null
        },
        {
          transaction_id: 3,
          category_id: 999,
          confidence: 0.3,
          reason: 'Potential subscription',
          suggested_category: { name: 'Abonnements', type: 'expense' }
        }
      ];
    }
  };
  try {
    assert.deepEqual(await categorizeUnresolvedTransactions(database, 7, categorizer, NOW), {
      submitted: 3,
      applied: 1,
      pendingReview: 2,
      categorySuggestions: 1
    });
    assert.deepEqual(
      database.prepare(`
        SELECT id, category_id, category_source, category_confidence FROM transactions ORDER BY id
      `).all().map((row) => ({ ...row })),
      [
        { id: 1, category_id: 1, category_source: 'ai', category_confidence: 0.96 },
        { id: 2, category_id: null, category_source: null, category_confidence: null },
        { id: 3, category_id: null, category_source: null, category_confidence: null }
      ]
    );
    assert.deepEqual(
      database.prepare(`
        SELECT transaction_id, category_id, confidence, suggested_category_name, status
        FROM ai_categorization_reviews ORDER BY transaction_id
      `).all().map((row) => ({ ...row })),
      [
        { transaction_id: 2, category_id: 2, confidence: 0.55, suggested_category_name: null, status: 'pending' },
        { transaction_id: 3, category_id: null, confidence: 0.3, suggested_category_name: 'Abonnements', status: 'pending' }
      ]
    );
    assert.deepEqual({ ...(database.prepare(`
      SELECT yuvomi_user_id, suggested_name, suggested_type, status FROM category_suggestions
    `).get() as Record<string, unknown>) }, {
      yuvomi_user_id: 7,
      suggested_name: 'Abonnements',
      suggested_type: 'expense',
      status: 'pending'
    });
    const serializedInput = JSON.stringify(received);
    assert.doesNotMatch(serializedInput, new RegExp(RAW_IBAN));
    assert.doesNotMatch(serializedInput, /jane\.doe@example\.com|151 12345678|iban_encrypted|raw_payload/i);
    assert.match(serializedInput, /hmac-recipient/);
  } finally {
    database.close();
  }
});

test('keeps the explicit automatic threshold at 0.75, including its boundaries', async () => {
  assert.equal(AUTO_APPLY_CONFIDENCE, 0.75);
  const database = fixture();
  const categorizer: CategorizationClient = {
    categorize: async () => [
      { transaction_id: 1, category_id: 1, confidence: 0.74, reason: 'Unsicher.', suggested_category: null },
      { transaction_id: 2, category_id: 1, confidence: 0.75, reason: 'Wahrscheinlich.', suggested_category: null },
      { transaction_id: 3, category_id: 1, confidence: 0.90, reason: 'Sicher.', suggested_category: null }
    ]
  };
  try {
    assert.deepEqual(await categorizeUnresolvedTransactions(database, 7, categorizer, NOW), {
      submitted: 3, applied: 2, pendingReview: 1, categorySuggestions: 0
    });
    assert.deepEqual(database.prepare(`SELECT transaction_id, confidence FROM ai_categorization_reviews`).all().map((row) => ({ ...row })), [{ transaction_id: 1, confidence: 0.74 }]);
  } finally { database.close(); }
});

test('bootstraps category suggestions with an empty allowlist', async () => {
  const database = fixture();
  database.exec('DELETE FROM categories;');
  let receivedCategories: unknown;
  const categorizer: CategorizationClient = {
    categorize: async ({ categories, transactions }) => {
      receivedCategories = categories;
      return transactions.map((transaction) => ({
        transaction_id: transaction.transaction_id,
        category_id: null,
        confidence: 0.6,
        reason: 'Grocery purchase',
        suggested_category: { name: 'Lebensmittel', type: 'expense' as const }
      }));
    }
  };
  try {
    const result = await categorizeUnresolvedTransactions(database, 7, categorizer, NOW);
    assert.equal(result.submitted, 3);
    assert.deepEqual(receivedCategories, []);
    assert.equal(database.prepare('SELECT count(*) AS count FROM category_suggestions').get()?.count, 1);
    acceptCategorySuggestion(database, { yuvomiUserId: 7, suggestionId: 1, now: NOW });
    database.prepare(`INSERT INTO transactions (account_id, provider_transaction_id, amount_cents, currency, direction, status, created_at, updated_at) VALUES (1, 'bootstrap-next', 500, 'EUR', 'outgoing', 'BOOK', ?, ?)`)
      .run(NOW.toISOString(), NOW.toISOString());
    await categorizeUnresolvedTransactions(database, 7, categorizer, NOW);
    assert.deepEqual((receivedCategories as Array<{ name: string; type: string }>).map(({ name, type }) => ({ name, type })), [{ name: 'Lebensmittel', type: 'expense' }]);
  } finally { database.close(); }
});

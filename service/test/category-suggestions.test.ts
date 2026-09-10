import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateDatabase } from '../src/db/database.js';
import {
  acceptCategorySuggestion,
  CategorySuggestionNotFoundError,
  dismissCategorySuggestion
} from '../src/services/category-suggestions.js';

const NOW = new Date('2026-09-20T12:00:00.000Z');

function fixture(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  database.prepare(`
    INSERT INTO category_suggestions (
      yuvomi_user_id, suggested_name, suggested_type, reason, sample_count, status, created_at
    ) VALUES
      (7, 'Abonnements', 'expense', 'Recurring charge', 3, 'pending', ?),
      (7, 'Archiv', 'expense', 'Existing inactive category', 1, 'pending', ?),
      (99, 'Private suggestion', 'expense', 'Other user', 1, 'pending', ?)
  `).run(NOW.toISOString(), NOW.toISOString(), NOW.toISOString());
  database.prepare(`
    INSERT INTO categories (name, type, active, created_at, updated_at)
    VALUES ('Archiv', 'expense', 0, ?, ?)
  `).run(NOW.toISOString(), NOW.toISOString());
  return database;
}

test('accepting a private suggestion explicitly creates or activates a category', () => {
  const database = fixture();
  try {
    assert.deepEqual(acceptCategorySuggestion(database, {
      yuvomiUserId: 7,
      suggestionId: 1,
      now: NOW
    }), {
      suggestionId: 1,
      category: { id: 2, name: 'Abonnements', type: 'expense', created: true }
    });
    assert.deepEqual({ ...(database.prepare(`
      SELECT status, decided_at FROM category_suggestions WHERE id = 1
    `).get() as Record<string, unknown>) }, {
      status: 'accepted',
      decided_at: NOW.toISOString()
    });
    assert.deepEqual(acceptCategorySuggestion(database, {
      yuvomiUserId: 7,
      suggestionId: 2,
      now: NOW
    }), {
      suggestionId: 2,
      category: { id: 1, name: 'Archiv', type: 'expense', created: false }
    });
    assert.equal(database.prepare('SELECT active FROM categories WHERE id = 1').get()?.active, 1);
  } finally {
    database.close();
  }
});

test('dismissing or accessing another users suggestion cannot create a category', () => {
  const database = fixture();
  try {
    dismissCategorySuggestion(database, { yuvomiUserId: 7, suggestionId: 1, now: NOW });
    assert.equal(database.prepare('SELECT status FROM category_suggestions WHERE id = 1').get()?.status, 'rejected');
    assert.throws(
      () => acceptCategorySuggestion(database, { yuvomiUserId: 7, suggestionId: 3, now: NOW }),
      CategorySuggestionNotFoundError
    );
    assert.equal(database.prepare('SELECT count(*) AS count FROM categories').get()?.count, 1);
  } finally {
    database.close();
  }
});

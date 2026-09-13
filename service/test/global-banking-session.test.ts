import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  createGlobalBankingSessionResolver,
  resolveGlobalBankingOwnerId
} from '../src/auth/global-banking-session.js';

test('maps another Yuvomi user to the owner of the existing Banking setup', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE enable_banking_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      yuvomi_user_id INTEGER NOT NULL
    );
    INSERT INTO enable_banking_connections (yuvomi_user_id) VALUES (17);
  `);

  const resolveSession = async () => ({
    id: 42,
    display_name: 'Jaqueline',
    role: 'user',
    permissions: { modules: { 'ext:banking': 'write' as const } }
  });
  const resolveBankingSession = createGlobalBankingSessionResolver(database, resolveSession);

  const user = await resolveBankingSession('session=jaqueline');
  assert.ok(user);
  assert.equal(user.id, 17);
  assert.equal(user.display_name, 'Jaqueline');
  assert.equal(user.permissions?.modules?.['ext:banking'], 'write');
});

test('keeps the current Yuvomi user when no Banking owner exists yet', async () => {
  const database = new DatabaseSync(':memory:');
  assert.equal(resolveGlobalBankingOwnerId(database, 42), 42);
});

test('prefers the oldest existing bank connection as the global owner', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE enable_banking_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      yuvomi_user_id INTEGER NOT NULL
    );
    CREATE TABLE weekly_budget_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      yuvomi_user_id INTEGER NOT NULL
    );
    INSERT INTO enable_banking_connections (yuvomi_user_id) VALUES (17), (42);
    INSERT INTO weekly_budget_configs (yuvomi_user_id) VALUES (99);
  `);

  assert.equal(resolveGlobalBankingOwnerId(database, 123), 17);
});

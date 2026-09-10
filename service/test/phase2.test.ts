import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  ensureDatabaseDirectory,
  migrateDatabase,
  openBankingDatabase
} from '../src/db/database.js';
import { createEncryptionService } from '../src/security/encryption.js';
import {
  counterpartyId,
  maskIban,
  normalizeIban,
  toPublicCounterparty
} from '../src/services/counterparty.js';

const TEST_KEY = 'ab'.repeat(32);
const TEST_IBAN = 'DE89 3704 0044 0532 0130 00';

test('opens only the Banking database and applies migrations idempotently', () => {
  const directory = mkdtempSync(join(tmpdir(), 'yuvomi-banking-phase2-'));
  const databasePath = join(directory, 'banking.db');

  try {
    const inMemory = new DatabaseSync(':memory:');
    assert.deepEqual(migrateDatabase(inMemory), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(migrateDatabase(inMemory), []);
    assert.equal(inMemory.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
    const appliedVersions = inMemory
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number }>;
    assert.deepEqual(appliedVersions.map((row) => Number(row.version)), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(
      inMemory.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transactions'"
      ).get()?.name,
      'transactions'
    );
    assert.equal(
      (inMemory.prepare('PRAGMA table_info(transactions)').all() as Array<{ name: string; type: string }>)
        .find((column) => column.name === 'amount_cents')?.type,
      'INTEGER'
    );
    inMemory.close();

    {
      const database = openBankingDatabase(databasePath);
      database.close();
    }

    assert.ok(existsSync(databasePath));

    assert.throws(
      () => ensureDatabaseDirectory(join(directory, 'yuvomi.db')),
      /never Yuvomi Core data/
    );
  } finally {
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50
    });
  }
});

test('encrypts and decrypts sensitive values with authenticated encryption', () => {
  const encryption = createEncryptionService(TEST_KEY);
  const encrypted = encryption.encrypt(TEST_IBAN);

  assert.match(encrypted, /^v1\.[^.]+\.[^.]+\.[^.]+$/);
  assert.ok(!encrypted.includes(TEST_IBAN));
  assert.equal(encryption.decrypt(encrypted), TEST_IBAN);
  assert.notEqual(encrypted, encryption.encrypt(TEST_IBAN));
  assert.throws(() => encryption.decrypt('v1.invalid.invalid.invalid'), /Invalid encrypted value/);
  assert.throws(() => createEncryptionService('not-a-key'), /32-byte/);
});

test('migrates legacy REAL money columns and keeps relational data intact', () => {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON;');
  for (const filename of [
    '001_init.sql',
    '002_phase2_indexes.sql',
    '003_enable_banking_flow.sql'
  ]) {
    database.exec(readFileSync(join(process.cwd(), 'migrations', filename), 'utf8'));
  }

  database.prepare(`
    INSERT INTO enable_banking_connections (
      yuvomi_user_id, status, created_at, updated_at
    ) VALUES (?, 'authorized', ?, ?)
  `).run(1, '2026-01-01', '2026-01-01');
  const connectionId = Number(database.prepare(
    'SELECT id FROM enable_banking_connections'
  ).get()?.id);
  database.prepare(`
    INSERT INTO bank_accounts (
      connection_id, provider_account_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?)
  `).run(connectionId, 'legacy-account', '2026-01-01', '2026-01-01');
  const accountId = Number(database.prepare('SELECT id FROM bank_accounts').get()?.id);
  database.prepare(`
    INSERT INTO transactions (
      account_id, provider_transaction_id, amount, currency, direction,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(accountId, 'legacy-transaction', 12.34, 'EUR', 'outgoing', '2026-01-01', '2026-01-01');
  database.prepare(`
    INSERT INTO transfer_suggestions (
      source_account_id, target_account_id, target_amount, computed_amount,
      deducted_amount, week_start, week_end, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(accountId, accountId, 4.5, 3.25, 0.5, '2026-01-01', '2026-01-07', '2026-01-01', '2026-01-01');

  database.exec(readFileSync(join(process.cwd(), 'migrations', '004_account_identity_and_consent_state.sql'), 'utf8'));
  database.exec(readFileSync(join(process.cwd(), 'migrations', '005_integer_money_and_transaction_keys.sql'), 'utf8'));

  assert.equal(database.prepare(
    'SELECT amount_cents FROM transactions WHERE id = 1'
  ).get()?.amount_cents, 1234);
  const transfer = database.prepare(`
    SELECT target_amount_cents, computed_amount_cents, deducted_amount_cents
    FROM transfer_suggestions WHERE id = 1
  `).get() as {
    target_amount_cents: number;
    computed_amount_cents: number;
    deducted_amount_cents: number;
  };
  assert.equal(transfer.target_amount_cents, 450);
  assert.equal(transfer.computed_amount_cents, 325);
  assert.equal(transfer.deducted_amount_cents, 50);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  database.close();
});

test('applies all later migrations to an existing phase-5 database', () => {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON;');
  for (const [version, filename] of [
    [1, '001_init.sql'],
    [2, '002_phase2_indexes.sql'],
    [3, '003_enable_banking_flow.sql'],
    [4, '004_account_identity_and_consent_state.sql'],
    [5, '005_integer_money_and_transaction_keys.sql']
  ] as const) {
    database.exec(readFileSync(join(process.cwd(), 'migrations', filename), 'utf8'));
    database.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
    ).run(version, '2026-01-01T00:00:00.000Z');
  }
  database.prepare(`
    INSERT INTO enable_banking_connections (yuvomi_user_id, status, created_at, updated_at)
    VALUES (?, 'authorized', ?, ?)
  `).run(1, '2026-01-01', '2026-01-01');
  const connectionId = Number(database.prepare(
    'SELECT id FROM enable_banking_connections'
  ).get()?.id);
  database.prepare(`
    INSERT INTO bank_accounts (connection_id, provider_account_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(connectionId, 'phase5-account', '2026-01-01', '2026-01-01');
  const accountId = Number(database.prepare('SELECT id FROM bank_accounts').get()?.id);
  database.prepare(`
    INSERT INTO transactions (
      account_id, provider_transaction_id, amount_cents, currency, direction,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(accountId, 'phase5-transaction', 100, 'EUR', 'outgoing', '2026-01-01', '2026-01-01');

  assert.deepEqual(migrateDatabase(database), [6, 7, 8, 9]);
  const transaction = database.prepare(
    'SELECT status, transaction_date FROM transactions'
  ).get() as { status: string; transaction_date: string | null };
  assert.equal(transaction.status, 'UNKNOWN');
  assert.equal(transaction.transaction_date, null);
  assert.equal(database.prepare(
    'SELECT aspsp_maximum_consent_validity FROM enable_banking_connections'
  ).get()?.aspsp_maximum_consent_validity, null);
  database.close();
});

test('normalizes IBANs and creates a deterministic HMAC counterparty ID', () => {
  assert.equal(normalizeIban(TEST_IBAN), 'DE89370400440532013000');
  assert.equal(
    counterpartyId(TEST_IBAN, 'phase2-test-secret'),
    'ca7c205761b361dbb272e36adf9d3af24b35d1151d802f6dd77e452cc1e1bd44'
  );
  assert.equal(
    counterpartyId('de89 3704 0044 0532 0130 00', 'phase2-test-secret'),
    counterpartyId(TEST_IBAN, 'phase2-test-secret')
  );
  assert.ok(maskIban(TEST_IBAN).startsWith('DE89'));
  assert.ok(maskIban(TEST_IBAN).endsWith('3000'));
  assert.ok(!maskIban(TEST_IBAN).includes('3704004405320130'));
});

test('public counterparty serialization never exposes encrypted or plaintext IBAN', () => {
  const encryption = createEncryptionService(TEST_KEY);
  const publicCounterparty = toPublicCounterparty({
    counterparty_id: counterpartyId(TEST_IBAN, 'phase2-test-secret'),
    display_name: 'Example Merchant',
    iban_encrypted: encryption.encrypt(TEST_IBAN)
  }, encryption);
  const serialized = JSON.stringify(publicCounterparty);

  assert.equal(publicCounterparty.iban_masked, maskIban(TEST_IBAN));
  assert.ok(!serialized.includes(TEST_IBAN));
  assert.ok(!serialized.includes('iban_encrypted'));
});

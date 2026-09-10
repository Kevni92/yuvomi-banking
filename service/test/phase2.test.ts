import { strict as assert } from 'node:assert';
import { existsSync, rmSync, mkdtempSync } from 'node:fs';
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
    assert.deepEqual(migrateDatabase(inMemory), [1, 2, 3]);
    assert.deepEqual(migrateDatabase(inMemory), []);
    assert.equal(inMemory.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
    const appliedVersions = inMemory
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number }>;
    assert.deepEqual(appliedVersions.map((row) => Number(row.version)), [1, 2, 3]);
    assert.equal(
      inMemory.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transactions'"
      ).get()?.name,
      'transactions'
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

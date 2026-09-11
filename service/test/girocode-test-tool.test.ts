import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateDatabase } from '../src/db/database.js';
import { createEncryptionService } from '../src/security/encryption.js';
import {
  createGiroCodeTestAsset,
  findGiroCodeTestImage,
  findOwnedGiroCodeTestView
} from '../src/services/girocode-test-assets.js';

const KEY = 'de'.repeat(32);
const PAYLOAD = 'BCD\n002\n1\nSCT\n\nRecipient\nDE89370400440532013000\nEUR25.00\n\n\nTest';

test('stores manual GiroCode payloads encrypted behind independent short-lived capabilities', () => {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  const encryption = createEncryptionService(KEY);
  const now = new Date('2026-09-11T12:00:00.000Z');
  const asset = createGiroCodeTestAsset(database, {
    yuvomiUserId: 7, payload: PAYLOAD, beneficiaryName: 'Recipient', ibanMasked: 'DE89••••••3000',
    amountCents: 2500, remittance: 'Test', now, encryption
  });
  assert.notEqual(asset.imageToken, asset.browserToken);
  const stored = database.prepare('SELECT * FROM girocode_test_assets').get() as Record<string, string>;
  assert.doesNotMatch(stored.payload_encrypted, /DE89370400440532013000/);
  assert.notEqual(stored.image_token_hash, asset.imageToken);
  assert.notEqual(stored.browser_token_hash, asset.browserToken);
  assert.equal(findGiroCodeTestImage(database, asset.imageToken, now, encryption)?.payload, PAYLOAD);
  assert.equal(findOwnedGiroCodeTestView(database, 7, asset.browserToken, now, encryption)?.ibanMasked, 'DE89••••••3000');
  assert.equal(findOwnedGiroCodeTestView(database, 8, asset.browserToken, now, encryption), null);
  assert.equal(findGiroCodeTestImage(database, asset.imageToken, new Date('2026-09-11T12:30:00.000Z'), encryption), null);
  database.close();
});

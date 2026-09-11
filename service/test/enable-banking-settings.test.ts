import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { EnableBankingClient } from '../src/enable-banking/client.js';
import { config } from '../src/config.js';
import { migrateDatabase } from '../src/db/database.js';
import {
  readEnableBankingRuntimeSettings,
  saveEnableBankingSettings
} from '../src/services/enable-banking-settings.js';

const TEST_KEY = 'ab'.repeat(32);
const PRIVATE_KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  .export({ type: 'pkcs8', format: 'pem' }).toString();

test('stores Enable Banking credentials encrypted and resolves them at request time', async () => {
  const previousEncryptionKey = config.secrets.dataEncryptionKey;
  const previousApplicationId = config.enableBanking.applicationId;
  const previousApiKey = config.enableBanking.apiKey;
  const previousApiUrl = config.enableBanking.apiUrl;
  const previousPrivateKeyPath = config.enableBanking.privateKeyPath;
  config.secrets.dataEncryptionKey = TEST_KEY;
  config.enableBanking.applicationId = '';
  config.enableBanking.apiKey = '';
  config.enableBanking.apiUrl = 'https://api.enablebanking.com';
  config.enableBanking.privateKeyPath = 'missing-enablebanking-private-key.pem';

  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  const fetchCalls: Array<{ url: string; apiKey: string | null }> = [];
  const client = new EnableBankingClient({
    database,
    fetcher: async (input, init) => {
      fetchCalls.push({
        url: String(input),
        apiKey: new Headers(init?.headers).get('x-api-key')
      });
      return new Response(JSON.stringify({ aspsps: [] }), { status: 200 });
    }
  });

  try {
    const saved = saveEnableBankingSettings(database, {
      environment: 'production',
      apiUrl: 'https://api.enablebanking.test',
      applicationId: 'application-id-test',
      apiKey: 'provider-api-key-test',
      privateKey: PRIVATE_KEY.trim(),
      now: new Date('2026-09-11T10:00:00.000Z')
    });
    assert.deepEqual(saved, {
      environment: 'production',
      api_url: 'https://api.enablebanking.test',
      application_id_configured: true,
      api_key_configured: true,
      private_key_configured: true
    });
    const stored = database.prepare(
      'SELECT key, value FROM settings WHERE key LIKE ? ORDER BY key'
    ).all('enable_banking.%') as Array<{ key: string; value: string }>;
    assert.equal(stored.length, 5);
    assert.ok(stored.every((row) => !row.value.includes(PRIVATE_KEY)));
    assert.deepEqual(readEnableBankingRuntimeSettings(database), {
      environment: 'production',
      apiUrl: 'https://api.enablebanking.test',
      applicationId: 'application-id-test',
      apiKey: 'provider-api-key-test',
      privateKey: PRIVATE_KEY.trim(),
      privateKeyPath: 'missing-enablebanking-private-key.pem'
    });

    await client.getAspsps();
    assert.equal(fetchCalls[0]?.url, 'https://api.enablebanking.test/aspsps');
    assert.equal(fetchCalls[0]?.apiKey, 'provider-api-key-test');

    saveEnableBankingSettings(database, {
      apiKey: 'provider-api-key-updated',
      now: new Date('2026-09-11T10:01:00.000Z')
    });
    await client.getAspsps();
    assert.equal(fetchCalls[1]?.apiKey, 'provider-api-key-updated');
  } finally {
    database.close();
    config.secrets.dataEncryptionKey = previousEncryptionKey;
    config.enableBanking.applicationId = previousApplicationId;
    config.enableBanking.apiKey = previousApiKey;
    config.enableBanking.apiUrl = previousApiUrl;
    config.enableBanking.privateKeyPath = previousPrivateKeyPath;
  }
});

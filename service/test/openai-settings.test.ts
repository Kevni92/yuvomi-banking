import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { migrateDatabase } from '../src/db/database.js';
import { readOpenAiRuntimeSettings } from '../src/services/openai-settings.js';

const TEST_KEY = 'ef'.repeat(32);
const API_KEY = 'sk-test-openai-value';
const NOW = new Date('2026-09-11T10:00:00.000Z');

async function listen(app: ReturnType<typeof createApp>): Promise<{ server: Server; origin: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server has no address.');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function writeUser() {
  return {
    id: 7,
    display_name: 'OpenAI Settings User',
    role: 'parent',
    permissions: { modules: { 'ext:banking': 'write' as const } }
  };
}

function mutationHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    origin: config.publicOrigin,
    cookie: 'yuvomi.sid=test; banking.csrf=openai-csrf',
    'x-banking-csrf': 'openai-csrf'
  };
}

test('stores the OpenAI key encrypted and exposes only safe settings metadata', async () => {
  const previousEncryptionKey = config.secrets.dataEncryptionKey;
  const previousApiKey = config.secrets.openAiApiKey;
  const previousModel = config.openAiModel;
  const previousFetch = globalThis.fetch;
  config.secrets.dataEncryptionKey = TEST_KEY;
  config.secrets.openAiApiKey = '';
  config.openAiModel = '';
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === 'https://api.openai.com/v1/models') {
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${API_KEY}`);
      return new Response(JSON.stringify({
        data: [
          { id: 'gpt-5.6-sol' },
          { id: 'gpt-5.6-terra' },
          { id: 'gpt-5.6-luna' },
          { id: 'gpt-image-2.5-sunburst' },
          { id: 'text-embedding-3-small' }
        ]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return previousFetch(input, init);
  };
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  const { server, origin } = await listen(createApp({
    database,
    resolveSession: async () => writeUser(),
    clock: () => NOW
  }));

  try {
    const initial = await fetch(`${origin}/api/extensions/banking/openai/settings`, {
      headers: { cookie: 'yuvomi.sid=test' }
    });
    assert.equal(initial.status, 200);
    const initialBody = await initial.json();
    assert.equal(initialBody.data.api_key_configured, false);
    assert.equal(initialBody.data.model, '');
    assert.equal('api_key' in initialBody.data, false);

    const missingCsrf = await fetch(`${origin}/api/extensions/banking/openai/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: 'yuvomi.sid=test' },
      body: JSON.stringify({ api_key: API_KEY, model: 'gpt-5.6-sol' })
    });
    assert.equal(missingCsrf.status, 403);

    const invalidModel = await fetch(`${origin}/api/extensions/banking/openai/settings`, {
      method: 'PUT',
      headers: mutationHeaders(),
      body: JSON.stringify({ api_key: API_KEY, model: 'not a model' })
    });
    assert.equal(invalidModel.status, 400);

    const saved = await fetch(`${origin}/api/extensions/banking/openai/settings`, {
      method: 'PUT',
      headers: mutationHeaders(),
      body: JSON.stringify({ api_key: API_KEY, model: 'gpt-5.6-sol' })
    });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.deepEqual(savedBody.data, {
      api_key_configured: true,
      model: 'gpt-5.6-sol'
    });
    assert.equal('api_key' in savedBody.data, false);

    const stored = database.prepare(
      'SELECT value FROM settings WHERE key = ?'
    ).get('openai.api_key_encrypted') as { value: string } | undefined;
    assert.ok(stored?.value);
    assert.notEqual(stored.value, API_KEY);
    assert.equal(stored.value.includes(API_KEY), false);
    assert.deepEqual(readOpenAiRuntimeSettings(database), {
      apiKey: API_KEY,
      model: 'gpt-5.6-sol'
    });

    const models = await fetch(`${origin}/api/extensions/banking/openai/models`, {
      headers: { cookie: 'yuvomi.sid=test' }
    });
    assert.equal(models.status, 200);
    const modelsBody = await models.json();
    assert.equal(modelsBody.data.error, null);
    assert.deepEqual(modelsBody.data.models.map((model: { id: string }) => model.id), [
      'gpt-5.6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra'
    ]);

    const modelOnlyUpdate = await fetch(`${origin}/api/extensions/banking/openai/settings`, {
      method: 'PUT',
      headers: mutationHeaders(),
      body: JSON.stringify({ model: 'gpt-5.6-terra' })
    });
    assert.equal(modelOnlyUpdate.status, 200);
    assert.deepEqual(readOpenAiRuntimeSettings(database), {
      apiKey: API_KEY,
      model: 'gpt-5.6-terra'
    });
  } finally {
    await close(server);
    database.close();
    config.secrets.dataEncryptionKey = previousEncryptionKey;
    config.secrets.openAiApiKey = previousApiKey;
    config.openAiModel = previousModel;
    globalThis.fetch = previousFetch;
  }
});

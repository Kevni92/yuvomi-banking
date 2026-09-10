import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';
import type { EnableBankingClient, StartAuthorizationRequest } from '../src/enable-banking/client.js';
import { migrateDatabase } from '../src/db/database.js';
import { config } from '../src/config.js';

const TEST_KEY = 'ef'.repeat(32);

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

function user() {
  return {
    id: 7,
    display_name: 'Banking Test User',
    role: 'parent',
    permissions: { modules: { 'ext:banking': 'write' as const } }
  };
}

test('protects the authorization start route with Origin and double-submit CSRF', async () => {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  let called = false;
  const client = {
    startAuthorization: async () => {
      called = true;
      return { url: 'https://auth.enablebanking.com/ais/start?sessionid=test', authorization_id: 'authorization-1' };
    }
  } as unknown as EnableBankingClient;
  const { server, origin } = await listen(createApp({
    database,
    enableBankingClient: client,
    resolveSession: async () => user()
  }));

  try {
    const denied = await fetch(`${origin}/api/extensions/banking/enablebanking/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'yuvomi.sid=test' },
      body: JSON.stringify({ country: 'DE', name: 'Mock Bank' })
    });
    assert.equal(denied.status, 403);
    assert.equal(called, false);

    const allowed = await fetch(`${origin}/api/extensions/banking/enablebanking/start`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: config.publicOrigin,
        cookie: 'yuvomi.sid=test; banking.csrf=csrf-token',
        'x-banking-csrf': 'csrf-token'
      },
      body: JSON.stringify({ country: 'DE', name: 'Mock Bank' })
    });
    assert.equal(allowed.status, 201);
    assert.equal(called, true);
    assert.equal((await allowed.json()).data.url, 'https://auth.enablebanking.com/ais/start?sessionid=test');
  } finally {
    await close(server);
    database.close();
  }
});

test('correlates the callback with state and encrypts returned account data', async () => {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  const previousKey = config.secrets.dataEncryptionKey;
  config.secrets.dataEncryptionKey = TEST_KEY;
  let startRequest: StartAuthorizationRequest | undefined;
  const client = {
    startAuthorization: async (request: StartAuthorizationRequest) => {
      startRequest = request;
      return {
        url: 'https://auth.enablebanking.com/ais/start?sessionid=test',
        authorization_id: 'authorization-1'
      };
    },
    authorizeSession: async (code: string) => {
      assert.equal(code, 'one-time-code');
      return {
        session_id: 'session-1',
        access: { valid_until: '2026-12-31T00:00:00.000Z' },
        accounts: ['account-1']
      };
    },
    getAccountDetails: async (accountId: string) => {
      assert.equal(accountId, 'account-1');
      return { uid: accountId, name: 'Checking', iban: 'DE89 3704 0044 0532 0130 00', currency: 'EUR' };
    }
  } as unknown as EnableBankingClient;
  const { server, origin } = await listen(createApp({
    database,
    enableBankingClient: client,
    resolveSession: async () => user()
  }));

  try {
    const start = await fetch(`${origin}/api/extensions/banking/enablebanking/start`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: config.publicOrigin,
        cookie: 'yuvomi.sid=test; banking.csrf=csrf-token',
        'x-banking-csrf': 'csrf-token'
      },
      body: JSON.stringify({ country: 'DE', name: 'Mock Bank' })
    });
    assert.equal(start.status, 201);
    assert.ok(startRequest?.state);

    const callback = await fetch(
      `${origin}/api/extensions/banking/enablebanking/callback?code=one-time-code&state=${encodeURIComponent(startRequest!.state)}`,
      { redirect: 'manual' }
    );
    assert.equal(callback.status, 303);
    assert.match(callback.headers.get('location') ?? '', /banking=connected/);
    assert.equal(database.prepare("SELECT status FROM enable_banking_connections").get()?.status, 'authorized');
    const stored = database.prepare('SELECT iban_encrypted FROM bank_accounts').get() as { iban_encrypted: string };
    assert.ok(stored.iban_encrypted);
    assert.ok(!stored.iban_encrypted.includes('DE89370400440532013000'));
  } finally {
    config.secrets.dataEncryptionKey = previousKey;
    await close(server);
    database.close();
  }
});

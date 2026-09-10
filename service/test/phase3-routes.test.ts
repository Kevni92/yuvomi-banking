import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';
import type { EnableBankingClient, StartAuthorizationRequest } from '../src/enable-banking/client.js';
import { migrateDatabase } from '../src/db/database.js';
import { config } from '../src/config.js';

const TEST_KEY = 'ef'.repeat(32);

function mockAspsps(maximumConsentValidity = 180 * 24 * 60 * 60) {
  return async () => ({
    aspsps: [{
      name: 'Mock Bank',
      country: 'DE',
      maximum_consent_validity: maximumConsentValidity
    }]
  });
}

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

function readOnlyUser() {
  return {
    id: 7,
    display_name: 'Banking Read User',
    role: 'parent',
    permissions: { modules: { 'ext:banking': 'read' as const } }
  };
}

test('protects the authorization start route with Origin and double-submit CSRF', async () => {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  let called = false;
  const client = {
    getAspsps: mockAspsps(),
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
    getAspsps: mockAspsps(),
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
        accounts: [{
          account_id: { iban: 'DE89 3704 0044 0532 0130 00' },
          all_account_ids: [{ identification: 'account-number-1', scheme_name: 'BBAN' }],
          name: 'Checking',
          cash_account_type: 'CACC',
          currency: 'EUR',
          uid: 'account-1',
          identification_hash: 'account-hash-1',
          identification_hashes: ['account-hash-1']
        }]
      };
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
      body: JSON.stringify({
        country: 'DE',
        name: 'Mock Bank',
        maximum_consent_validity: 1,
        valid_until: '2999-12-31T00:00:00.000Z'
      })
    });
    assert.equal(start.status, 201);
    assert.ok(startRequest?.state);
    const requestedValidUntil = Date.parse(startRequest!.access.valid_until);
    assert.ok(requestedValidUntil >= Date.now() + 89 * 24 * 60 * 60 * 1_000);
    assert.ok(requestedValidUntil <= Date.now() + 90 * 24 * 60 * 60 * 1_000 + 1_000);
    assert.equal(
      database.prepare(
        'SELECT aspsp_maximum_consent_validity FROM enable_banking_connections'
      ).get()?.aspsp_maximum_consent_validity,
      180 * 24 * 60 * 60
    );

    const callback = await fetch(
      `${origin}/api/extensions/banking/enablebanking/callback?code=one-time-code&state=${encodeURIComponent(startRequest!.state)}`,
      { redirect: 'manual' }
    );
    assert.equal(callback.status, 303);
    assert.match(callback.headers.get('location') ?? '', /banking=connected/);
    assert.equal(database.prepare("SELECT status FROM enable_banking_connections").get()?.status, 'authorized');
    assert.equal(
      database.prepare('SELECT valid_until FROM enable_banking_connections').get()?.valid_until,
      startRequest!.access.valid_until
    );
    const stored = database.prepare('SELECT iban_encrypted FROM bank_accounts').get() as { iban_encrypted: string };
    assert.ok(stored.iban_encrypted);
    assert.ok(!stored.iban_encrypted.includes('DE89370400440532013000'));
    const accountRow = database.prepare(
      'SELECT provider_account_id, identification_hash, account_type FROM bank_accounts'
    ).get() as {
      provider_account_id: string;
      identification_hash: string;
      account_type: string;
    };
    assert.equal(accountRow.provider_account_id, 'account-1');
    assert.equal(accountRow.identification_hash, 'account-hash-1');
    assert.equal(accountRow.account_type, 'CACC');

    const accountsResponse = await fetch(`${origin}/api/extensions/banking/accounts`, {
      headers: { cookie: 'yuvomi.sid=test' }
    });
    const accountsBody = await accountsResponse.json();
    assert.equal(accountsResponse.status, 200);
    assert.equal(Object.hasOwn(accountsBody.data[0], 'provider_account_id'), false);

    const replay = await fetch(
      `${origin}/api/extensions/banking/enablebanking/callback?code=one-time-code&state=${encodeURIComponent(startRequest!.state)}`,
      { redirect: 'manual' }
    );
    assert.equal(replay.status, 400);
  } finally {
    config.secrets.dataEncryptionKey = previousKey;
    await close(server);
    database.close();
  }
});

test('rejects unknown and expired authorization states', async () => {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  const client = {
    getAspsps: mockAspsps(),
    startAuthorization: async (request: StartAuthorizationRequest) => ({
      url: 'https://auth.enablebanking.com/ais/start?sessionid=test',
      authorization_id: request.state
    }),
    authorizeSession: async () => {
      throw new Error('expired state must not reach the provider');
    }
  } as unknown as EnableBankingClient;
  const { server, origin } = await listen(createApp({
    database,
    enableBankingClient: client,
    resolveSession: async () => user()
  }));

  try {
    const unknown = await fetch(
      `${origin}/api/extensions/banking/enablebanking/callback?code=unused&state=unknown-state`,
      { redirect: 'manual' }
    );
    assert.equal(unknown.status, 400);

    let state = '';
    const startClient = {
      getAspsps: mockAspsps(),
      startAuthorization: async (request: StartAuthorizationRequest) => {
        state = request.state;
        return { url: 'https://auth.enablebanking.com/ais/start?sessionid=test', authorization_id: 'authorization-1' };
      }
    } as unknown as EnableBankingClient;
    const startApp = createApp({
      database,
      enableBankingClient: startClient,
      resolveSession: async () => user()
    });
    const startServer = await listen(startApp);
    try {
      const start = await fetch(`${startServer.origin}/api/extensions/banking/enablebanking/start`, {
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
    } finally {
      await close(startServer.server);
    }

    database.prepare(`
      UPDATE enable_banking_connections SET state_expires_at = ? WHERE state_hash IS NOT NULL
    `).run('2020-01-01T00:00:00.000Z');
    const expired = await fetch(
      `${origin}/api/extensions/banking/enablebanking/callback?code=unused&state=${encodeURIComponent(state)}`,
      { redirect: 'manual' }
    );
    assert.equal(expired.status, 400);
    assert.equal(database.prepare('SELECT status FROM enable_banking_connections').get()?.status, 'failed');
  } finally {
    await close(server);
    database.close();
  }
});

test('read-only users can view local transactions but cannot synchronize', async () => {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  database.prepare(`
    INSERT INTO enable_banking_connections (
      yuvomi_user_id, status, created_at, updated_at
    ) VALUES (?, 'authorized', ?, ?)
  `).run(7, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  const connectionId = Number(database.prepare(
    'SELECT id FROM enable_banking_connections'
  ).get()?.id);
  database.prepare(`
    INSERT INTO bank_accounts (
      connection_id, provider_account_id, display_name, currency, account_type,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    connectionId,
    'provider-account-1',
    'Checking',
    'EUR',
    'CACC',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z'
  );
  let providerCalls = 0;
  const client = {
    getAllAccountTransactions: async () => {
      providerCalls += 1;
      return { pages: 1, transactions: [] };
    }
  } as unknown as EnableBankingClient;
  const { server, origin } = await listen(createApp({
    database,
    enableBankingClient: client,
    resolveSession: async () => readOnlyUser()
  }));

  try {
    const details = await fetch(`${origin}/api/extensions/banking/accounts/1/transactions`, {
      headers: { cookie: 'yuvomi.sid=read-only' }
    });
    assert.equal(details.status, 200);
    assert.deepEqual(await details.json(), { data: { transactions: [] } });

    const sync = await fetch(`${origin}/api/extensions/banking/accounts/1/sync`, {
      method: 'POST',
      headers: {
        origin: config.publicOrigin,
        cookie: 'yuvomi.sid=read-only; banking.csrf=csrf-token',
        'x-banking-csrf': 'csrf-token'
      }
    });
    assert.equal(sync.status, 403);
    assert.equal(providerCalls, 0);
  } finally {
    await close(server);
    database.close();
  }
});

test('re-consent matches the existing account by identification_hash for the same user', async () => {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  const previousKey = config.secrets.dataEncryptionKey;
  config.secrets.dataEncryptionKey = TEST_KEY;
  const states: string[] = [];
  const sessions = [
    {
      session_id: 'session-one',
      access: { valid_until: '2026-12-31T00:00:00.000Z' },
      accounts: [{
        uid: 'uid-one',
        account_id: { iban: 'DE89 3704 0044 0532 0130 00' },
        name: 'Checking',
        currency: 'EUR',
        cash_account_type: 'CACC',
        identification_hash: 'stable-account-hash',
        identification_hashes: ['stable-account-hash']
      }]
    },
    {
      session_id: 'session-two',
      access: { valid_until: '2027-12-31T00:00:00.000Z' },
      accounts: [{
        uid: 'uid-two',
        account_id: { iban: 'DE89 3704 0044 0532 0130 00' },
        name: 'Checking renamed',
        currency: 'EUR',
        cash_account_type: 'CACC',
        identification_hash: 'stable-account-hash',
        identification_hashes: ['stable-account-hash']
      }]
    }
  ];
  const client = {
    getAspsps: mockAspsps(),
    startAuthorization: async (request: StartAuthorizationRequest) => {
      states.push(request.state);
      return {
        url: 'https://auth.enablebanking.com/ais/start?sessionid=test',
        authorization_id: `authorization-${states.length}`
      };
    },
    authorizeSession: async () => sessions.shift()!
  } as unknown as EnableBankingClient;
  const { server, origin } = await listen(createApp({
    database,
    enableBankingClient: client,
    resolveSession: async () => user()
  }));

  async function startConnection(): Promise<void> {
    const response = await fetch(`${origin}/api/extensions/banking/enablebanking/start`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: config.publicOrigin,
        cookie: 'yuvomi.sid=test; banking.csrf=csrf-token',
        'x-banking-csrf': 'csrf-token'
      },
      body: JSON.stringify({ country: 'DE', name: 'Mock Bank' })
    });
    assert.equal(response.status, 201);
  }

  try {
    await startConnection();
    const first = await fetch(
      `${origin}/api/extensions/banking/enablebanking/callback?code=first&state=${encodeURIComponent(states[0])}`,
      { redirect: 'manual' }
    );
    assert.equal(first.status, 303);
    const firstAccount = database.prepare(
      'SELECT id FROM bank_accounts'
    ).get() as { id: number };
    database.prepare('UPDATE bank_accounts SET yuvomi_budget_account_id = ? WHERE id = ?')
      .run(123, firstAccount.id);
    database.prepare(`
      INSERT INTO enable_banking_connections (
        yuvomi_user_id, status, created_at, updated_at
      ) VALUES (?, 'authorized', ?, ?)
    `).run(99, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    const otherUserConnectionId = Number(database.prepare(`
      SELECT id FROM enable_banking_connections WHERE yuvomi_user_id = 99
    `).get()?.id);
    database.prepare(`
      INSERT INTO bank_accounts (
        connection_id, provider_account_id, display_name, currency,
        account_type, identification_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      otherUserConnectionId,
      'other-user-uid',
      'Other user account',
      'EUR',
      'CACC',
      'stable-account-hash',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    );

    await startConnection();
    const second = await fetch(
      `${origin}/api/extensions/banking/enablebanking/callback?code=second&state=${encodeURIComponent(states[1])}`,
      { redirect: 'manual' }
    );
    assert.equal(second.status, 303);

    assert.equal(database.prepare('SELECT count(*) AS count FROM bank_accounts').get()?.count, 2);
    const account = database.prepare(`
      SELECT id, connection_id, provider_account_id, identification_hash,
             yuvomi_budget_account_id
      FROM bank_accounts
    `).get() as {
      id: number;
      connection_id: number;
      provider_account_id: string;
      identification_hash: string;
      yuvomi_budget_account_id: number;
    };
    assert.equal(account.id, firstAccount.id);
    assert.equal(account.provider_account_id, 'uid-two');
    assert.equal(account.identification_hash, 'stable-account-hash');
    assert.equal(account.yuvomi_budget_account_id, 123);
  } finally {
    config.secrets.dataEncryptionKey = previousKey;
    await close(server);
    database.close();
  }
});

test('best-effort closes a provider session when local persistence fails', async () => {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  const previousKey = config.secrets.dataEncryptionKey;
  config.secrets.dataEncryptionKey = TEST_KEY;
  let state = '';
  let deleteCalls = 0;
  const client = {
    getAspsps: mockAspsps(),
    startAuthorization: async (request: StartAuthorizationRequest) => {
      state = request.state;
      return {
        url: 'https://auth.enablebanking.com/ais/start?sessionid=test',
        authorization_id: 'authorization-1'
      };
    },
    authorizeSession: async () => ({
      session_id: 'provider-session-to-clean',
      accounts: [{
        uid: 'provider-account-1',
        account_id: { iban: 'DE89 3704 0044 0532 0130 00' },
        name: 'Checking',
        currency: 'EUR',
        cash_account_type: 'CACC',
        identification_hash: 'account-hash-1',
        identification_hashes: ['account-hash-1']
      }]
    }),
    deleteSession: async (sessionId: string) => {
      assert.equal(sessionId, 'provider-session-to-clean');
      deleteCalls += 1;
      return { message: 'OK' };
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
    database.exec(`
      CREATE TRIGGER fail_bank_account_insert
      BEFORE INSERT ON bank_accounts
      BEGIN
        SELECT RAISE(ABORT, 'test persistence failure');
      END;
    `);

    const callback = await fetch(
      `${origin}/api/extensions/banking/enablebanking/callback?code=one-time-code&state=${encodeURIComponent(state)}`,
      { redirect: 'manual' }
    );
    assert.equal(callback.status, 303);
    assert.match(callback.headers.get('location') ?? '', /banking=error/);
    assert.equal(deleteCalls, 1);
    assert.equal(database.prepare('SELECT status FROM enable_banking_connections').get()?.status, 'failed');
  } finally {
    config.secrets.dataEncryptionKey = previousKey;
    await close(server);
    database.close();
  }
});

test('returns imported transactions without exposing raw banking payloads', async () => {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  const previousKey = config.secrets.dataEncryptionKey;
  const previousHmac = config.secrets.counterpartyHmac;
  config.secrets.dataEncryptionKey = TEST_KEY;
  config.secrets.counterpartyHmac = 'transaction-route-test-secret';
  database.prepare(`
    INSERT INTO enable_banking_connections (
      yuvomi_user_id, status, created_at, updated_at
    ) VALUES (?, 'authorized', ?, ?)
  `).run(7, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  const connectionId = Number(database.prepare(
    'SELECT id FROM enable_banking_connections'
  ).get()?.id);
  database.prepare(`
    INSERT INTO bank_accounts (
      connection_id, provider_account_id, display_name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(connectionId, 'provider-account-1', 'Checking', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

  let providerCalls = 0;
  const client = {
    getAllAccountTransactions: async (accountId: string) => {
      providerCalls += 1;
      assert.equal(accountId, 'provider-account-1');
      return {
        pages: 1,
        transactions: [{
          entry_reference: 'route-transaction-1',
          transaction_amount: { amount: '42.50', currency: 'EUR' },
          credit_debit_indicator: 'DBIT',
          booking_date: '2026-01-02',
          creditor: { name: 'Safe Merchant' },
          creditor_account: { iban: 'DE89370400440532013000' },
          remittance_information: ['Order 123']
        }]
      };
    }
  } as unknown as EnableBankingClient;
  const { server, origin } = await listen(createApp({
    database,
    enableBankingClient: client,
    resolveSession: async () => user()
  }));

  try {
    const denied = await fetch(`${origin}/api/extensions/banking/accounts/1/sync`, {
      method: 'POST',
      headers: { origin: config.publicOrigin, cookie: 'yuvomi.sid=test' }
    });
    assert.equal(denied.status, 403);
    assert.equal(providerCalls, 0);

    const response = await fetch(`${origin}/api/extensions/banking/accounts/1/sync`, {
      method: 'POST',
      headers: {
        origin: config.publicOrigin,
        cookie: 'yuvomi.sid=test; banking.csrf=csrf-token',
        'x-banking-csrf': 'csrf-token'
      }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data.imported, { inserted: 1, updated: 0 });
    assert.equal(body.data.transactions.length, 1);
    assert.deepEqual(body.data.transactions[0], {
      id: 1,
      booking_date: '2026-01-02',
      value_date: null,
      transaction_date: null,
      amount: '42.50',
      currency: 'EUR',
      direction: 'outgoing',
      counterparty_name: 'Safe Merchant',
      purpose: 'Order 123',
      merchant_name: null,
      status: 'UNKNOWN',
      category_id: null,
      category_source: null,
      category_confidence: null
    });
    assert.doesNotMatch(JSON.stringify(body), /DE89370400440532013000|raw_payload_encrypted/);
  } finally {
    config.secrets.dataEncryptionKey = previousKey;
    config.secrets.counterpartyHmac = previousHmac;
    await close(server);
    database.close();
  }
});

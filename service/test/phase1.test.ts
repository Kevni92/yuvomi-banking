import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import {
  bankingPermission,
  resolveYuvomiUser,
  type YuvomiUser
} from '../src/auth/yuvomi-session.js';
import { config } from '../src/config.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server has no TCP address.');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
}

async function requestJson(url: string): Promise<{ status: number; body: any }> {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

async function withApp<T>(
  app: ReturnType<typeof createApp>,
  callback: (origin: string) => Promise<T>
): Promise<T> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.once('listening', () => resolvePromise());
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server has no TCP address.');

  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await close(server);
  }
}

test('health is public, names the service, and disables caching', async () => {
  await withApp(createApp(), async (origin) => {
    const response = await fetch(`${origin}/api/extensions/banking/health`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      ok: true,
      service: 'yuvomi-banking',
      version: '0.1.0'
    });
  });
});

test('me rejects requests without a Yuvomi session', async () => {
  let resolverCalls = 0;
  await withApp(createApp({
    resolveSession: async () => {
      resolverCalls += 1;
      return null;
    }
  }), async (origin) => {
    const result = await requestJson(`${origin}/api/extensions/banking/me`);
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { error: 'Not authenticated.' });
    assert.equal(resolverCalls, 1);
  });
});

test('me accepts both read and write access, but denies none', async () => {
  const allowedUser = (access: 'read' | 'write'): YuvomiUser => ({
    id: 17,
    display_name: 'Test user',
    role: 'parent',
    permissions: { modules: { 'ext:banking': access } }
  });

  for (const access of ['read', 'write'] as const) {
    await withApp(createApp({ resolveSession: async (cookie) => {
      assert.equal(cookie, 'yuvomi.sid=test-session');
      return allowedUser(access);
    } }), async (origin) => {
      const response = await fetch(`${origin}/api/extensions/banking/me`, {
        headers: { cookie: 'yuvomi.sid=test-session' }
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), {
        data: {
          id: 17,
          display_name: 'Test user',
          role: 'parent',
          banking_permission: access
        }
      });
    });
  }

  await withApp(createApp({ resolveSession: async () => ({
    id: 17,
    permissions: { modules: { 'ext:banking': 'none' } }
  }) }), async (origin) => {
    const result = await requestJson(`${origin}/api/extensions/banking/me`);
    assert.equal(result.status, 403);
    assert.deepEqual(result.body, { error: 'Banking module access denied.' });
  });
});

test('Yuvomi session resolver forwards the cookie and reads current auth shape', async () => {
  let receivedCookie: string | undefined;
  const upstream = createServer((request, response) => {
    assert.equal(request.url, '/api/v1/auth/me');
    receivedCookie = request.headers.cookie;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      user: { id: 23, display_name: 'Yuvomi user', role: 'parent' },
      permissions: {
        admin: false,
        modules: { 'ext:banking': 'read' }
      }
    }));
  });
  const previousUrl = config.yuvomiInternalUrl;
  const origin = await listen(upstream);

  try {
    config.yuvomiInternalUrl = origin;
    const user = await resolveYuvomiUser('yuvomi.sid=forward-me');
    assert.equal(receivedCookie, 'yuvomi.sid=forward-me');
    assert.deepEqual(user, {
      id: 23,
      display_name: 'Yuvomi user',
      role: 'parent',
      permissions: { modules: { 'ext:banking': 'read' } }
    });
  } finally {
    config.yuvomiInternalUrl = previousUrl;
    await close(upstream);
  }
});

test('me uses the real Yuvomi resolver and ignores browser identity fields', async () => {
  const upstream = createServer((request, response) => {
    assert.equal(request.url, '/api/v1/auth/me');
    assert.equal(request.headers.cookie, 'yuvomi.sid=real-session');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      user: { id: 31, display_name: 'Verified user', role: 'parent' },
      permissions: { modules: { 'ext:banking': 'write' } }
    }));
  });
  const previousUrl = config.yuvomiInternalUrl;
  const upstreamOrigin = await listen(upstream);

  try {
    config.yuvomiInternalUrl = upstreamOrigin;
    await withApp(createApp(), async (origin) => {
      const response = await fetch(
        `${origin}/api/extensions/banking/me?user_id=999&role=admin`,
        { headers: { cookie: 'yuvomi.sid=real-session' } }
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        data: {
          id: 31,
          display_name: 'Verified user',
          role: 'parent',
          banking_permission: 'write'
        }
      });
    });
  } finally {
    config.yuvomiInternalUrl = previousUrl;
    await close(upstream);
  }
});

test('permission helper fails closed for missing or unknown values', () => {
  assert.equal(bankingPermission({ id: 1 }), 'none');
  assert.equal(bankingPermission({
    id: 1,
    permissions: { modules: { 'ext:banking': 'none' } }
  }), 'none');
  assert.equal(bankingPermission({
    id: 1,
    permissions: { modules: { 'ext:banking': 'read' } }
  }), 'read');
});

test('module manifest exposes the Phase 1 Yuvomi contract', () => {
  const manifest = JSON.parse(readFileSync(
    resolve(process.cwd(), '../modules/banking/module.json'),
    'utf8'
  ));

  assert.equal(manifest.manifestVersion, 1);
  assert.equal(manifest.id, 'banking');
  assert.equal(manifest.entry, 'index.js');
  assert.equal(manifest.page.composition, 'data');
  assert.equal(manifest.page.width, 'wide');
  assert.equal(manifest.capabilities.api.prefix, '/api/extensions/banking');
  assert.equal(manifest.capabilities.permissions.module.labelKey, 'module');
});

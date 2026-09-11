import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateDatabase } from '../src/db/database.js';
import {
  ensureMerchantLogo,
  MerchantLogoFetchError,
  MerchantLogoNotFoundError,
  readMerchantLogo
} from '../src/services/merchant-logos.js';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

test('uses only a registered HTTPS target and stores valid logo bytes locally', async () => {
  const database = new DatabaseSync(':memory:');
  const directory = mkdtempSync(join(tmpdir(), 'yuvomi-merchant-logos-'));
  migrateDatabase(database);
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls += 1;
    assert.equal(String(input), 'https://www.lidl.de/favicon.ico');
    assert.equal(init?.redirect, 'error');
    return new Response(PNG, { headers: { 'content-type': 'image/png' } });
  };
  try {
    const cached = await ensureMerchantLogo(database, 'lidl', { cacheDirectory: directory, fetcher });
    assert.equal(cached.contentType, 'image/png');
    assert.deepEqual(cached.content, PNG);
    assert.equal(calls, 1);
    const loaded = await readMerchantLogo(database, 'lidl', directory);
    assert.deepEqual(loaded.content, PNG);
    await ensureMerchantLogo(database, 'lidl', { cacheDirectory: directory, fetcher });
    assert.equal(calls, 1, 'the valid local cache avoids another network request');
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects non-registry keys and invalid response bytes', async () => {
  const database = new DatabaseSync(':memory:');
  const directory = mkdtempSync(join(tmpdir(), 'yuvomi-merchant-logos-'));
  migrateDatabase(database);
  try {
    await assert.rejects(
      ensureMerchantLogo(database, 'https://example.invalid/logo.png', { cacheDirectory: directory }),
      MerchantLogoNotFoundError
    );
    await assert.rejects(
      ensureMerchantLogo(database, 'lidl', {
        cacheDirectory: directory,
        fetcher: async () => new Response('not an image', {
          headers: { 'content-type': 'image/png' }
        })
      }),
      MerchantLogoFetchError
    );
    assert.equal(database.prepare('SELECT count(*) AS count FROM merchant_logos').get()?.count, 0);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

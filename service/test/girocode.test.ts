import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { migrateDatabase } from '../src/db/database.js';
import { createEncryptionService } from '../src/security/encryption.js';
import {
  assertValidIban,
  buildEpcQrPayload,
  giroCodePayloadSha256,
  renderGiroCodePng
} from '../src/services/girocode.js';

const TEST_KEY = 'ef'.repeat(32);
const TARGET_IBAN = 'DE89370400440532013000';
const PURPOSE = 'WB 2026-09-13: 450,00 - 30,00 Direkt - 100,00 N26 = 320,00 EUR';

test('builds an EPC069-12 v3.1 version-2 UTF-8 payload', () => {
  const payload = buildEpcQrPayload({
    beneficiaryName: 'Weekly Budget User',
    iban: TARGET_IBAN,
    amountCents: 32000,
    remittance: PURPOSE
  });
  assert.equal(payload, [
    'BCD',
    '002',
    '1',
    'SCT',
    '',
    'Weekly Budget User',
    TARGET_IBAN,
    'EUR320.00',
    '',
    '',
    PURPOSE
  ].join('\n'));
  assert.equal(assertValidIban(`DE89 3704 0044 0532 0130 00`), TARGET_IBAN);
  assert.match(giroCodePayloadSha256(payload), /^[a-f0-9]{64}$/);
  assert.throws(
    () => buildEpcQrPayload({
      beneficiaryName: 'Weekly Budget User',
      iban: 'DE89370400440532013001',
      amountCents: 32000,
      remittance: PURPOSE
    }),
    /checksum/
  );
  assert.throws(
    () => buildEpcQrPayload({
      beneficiaryName: 'Weekly Budget User',
      iban: TARGET_IBAN,
      amountCents: 0,
      remittance: PURPOSE
    }),
    /outside the EPC range/
  );
});

test('renders the EPC payload as a PNG with error correction level M', async () => {
  const payload = buildEpcQrPayload({
    beneficiaryName: 'Weekly Budget User',
    iban: TARGET_IBAN,
    amountCents: 32000,
    remittance: PURPOSE
  });
  const png = await renderGiroCodePng(payload);
  assert.ok(png.length > 100);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test('serves GiroCode metadata and PNG only to the owning Banking user', async () => {
  const previousKey = config.secrets.dataEncryptionKey;
  config.secrets.dataEncryptionKey = TEST_KEY;
  const database = giroCodeFixture();
  const ownerApp = createApp({
    database,
    resolveSession: async () => bankingUser(7)
  });
  const { server, origin } = await listen(ownerApp);
  let ownerClosed = false;
  let other: { server: Server; origin: string } | null = null;
  try {
    const metadata = await fetch(
      `${origin}/api/extensions/banking/weekly-budget/transfers/1/girocode`,
      { headers: { cookie: 'yuvomi.sid=owner' } }
    );
    assert.equal(metadata.status, 200);
    assert.equal(metadata.headers.get('cache-control'), 'no-store');
    const metadataBody = await metadata.json();
    assert.equal(metadataBody.data.amount_cents, 32000);
    assert.equal(metadataBody.data.beneficiary_name, 'Weekly Budget User');
    assert.equal(metadataBody.data.iban_masked, 'DE89••••••3000');
    assert.equal(metadataBody.data.purpose, PURPOSE);
    assert.doesNotMatch(JSON.stringify(metadataBody), new RegExp(TARGET_IBAN));

    const png = await fetch(
      `${origin}/api/extensions/banking/weekly-budget/transfers/1/girocode.png`,
      { headers: { cookie: 'yuvomi.sid=owner' } }
    );
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.equal(png.headers.get('cache-control'), 'private, no-store');
    assert.equal(png.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(
      [...new Uint8Array(await png.arrayBuffer()).subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10]
    );

    database.prepare(`
      UPDATE transfer_suggestions
      SET computed_amount_cents = 0, payload_sha256 = NULL
      WHERE id = 1
    `).run();
    const noTransfer = await fetch(
      `${origin}/api/extensions/banking/weekly-budget/transfers/1/girocode.png`,
      { headers: { cookie: 'yuvomi.sid=owner' } }
    );
    assert.equal(noTransfer.status, 409);
    await close(server);
    ownerClosed = true;

    other = await listen(createApp({
      database,
      resolveSession: async () => bankingUser(99)
    }));
    const denied = await fetch(
      `${other.origin}/api/extensions/banking/weekly-budget/transfers/1/girocode.png`,
      { headers: { cookie: 'yuvomi.sid=other' } }
    );
    assert.equal(denied.status, 404);
  } finally {
    if (!ownerClosed) await close(server);
    if (other) await close(other.server);
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
  }
});

function giroCodeFixture(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  const now = '2026-09-13T16:30:00.000Z';
  const encryption = createEncryptionService(TEST_KEY);
  database.prepare(`
    INSERT INTO enable_banking_connections (
      yuvomi_user_id, status, created_at, updated_at
    ) VALUES (7, 'authorized', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO bank_accounts (
      connection_id, provider_account_id, display_name, iban_encrypted,
      currency, account_type, created_at, updated_at
    ) VALUES
      (1, 'source', 'Sparkasse', ?, 'EUR', 'CACC', ?, ?),
      (1, 'target', 'N26', ?, 'EUR', 'CACC', ?, ?)
  `).run(
    encryption.encrypt('DE12500105170648489890'),
    now,
    now,
    encryption.encrypt(TARGET_IBAN),
    now,
    now
  );
  database.prepare(`
    INSERT INTO weekly_budget_configs (
      yuvomi_user_id, enabled, source_account_id, target_account_id,
      target_amount_cents, currency, cutoff_weekday, cutoff_time, timezone,
      sync_time_1, sync_time_2, notification_enabled,
      notification_qr_preview, purpose_prefix, effective_from_date,
      target_beneficiary_name, created_at, updated_at
    ) VALUES (7, 1, 1, 2, 45000, 'EUR', 7, '18:30', 'Europe/Berlin',
              '06:00', '18:00', 0, 0, 'WB', '2026-09-06', ?, ?, ?)
  `).run('Weekly Budget User', now, now);
  const encryptedTargetIban = encryption.encrypt(TARGET_IBAN);
  database.prepare(`
    INSERT INTO weekly_budget_periods (
      config_id, period_key, period_start_date, period_end_date,
      scheduled_cutoff_at, finalized_at, trigger, status,
      source_account_id, source_account_name, target_account_id,
      target_account_name, target_beneficiary_name, target_iban_encrypted,
      target_amount_cents, currency, target_balance_cents,
      direct_expense_cents, raw_computed_amount_cents, computed_amount_cents,
      calculation_version, created_at, updated_at
    ) VALUES (1, 'weekly-budget:1:2026-09-13T16:30:00.000Z',
              '2026-09-06', '2026-09-13', ?, ?, 'scheduled', 'finalized',
              1, 'Sparkasse', 2, 'N26', 'Weekly Budget User', ?,
              45000, 'EUR', 10000, 3000, 32000, 32000,
              'weekly-budget-v1', ?, ?)
  `).run(now, now, encryptedTargetIban, now, now);
  const payload = buildEpcQrPayload({
    beneficiaryName: 'Weekly Budget User',
    iban: TARGET_IBAN,
    amountCents: 32000,
    remittance: PURPOSE
  });
  database.prepare(`
    INSERT INTO transfer_suggestions (
      period_id, revision, source_account_id, target_account_id,
      target_amount_cents, target_balance_cents, computed_amount_cents,
      deducted_amount_cents, raw_computed_amount_cents, overfunded_cents,
      week_start, week_end, purpose, payload_sha256, calculation_version,
      status, generated_at, created_at, updated_at
    ) VALUES (1, 1, 1, 2, 45000, 10000, 32000, 3000, 32000, 0,
              '2026-09-06', '2026-09-13', ?, ?, 'weekly-budget-v1',
              'proposed', ?, ?, ?)
  `).run(PURPOSE, giroCodePayloadSha256(payload), now, now, now);
  return database;
}

function bankingUser(id: number) {
  return {
    id,
    display_name: `User ${id}`,
    role: 'parent',
    permissions: { modules: { 'ext:banking': 'read' as const } }
  };
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

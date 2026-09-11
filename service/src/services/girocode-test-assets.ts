import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createEncryptionService, type EncryptionService } from '../security/encryption.js';

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TTL_MS = 30 * 60 * 1_000;

export interface GiroCodeTestAsset {
  id: number;
  yuvomiUserId: number;
  payload: string;
  beneficiaryName: string;
  ibanMasked: string;
  amountCents: number;
  currency: 'EUR';
  remittance: string;
  expiresAt: string;
}

export function createGiroCodeTestAsset(database: DatabaseSync, input: {
  yuvomiUserId: number; payload: string; beneficiaryName: string; ibanMasked: string;
  amountCents: number; remittance: string; now: Date; encryption?: EncryptionService;
}): { imageToken: string; browserToken: string; imagePath: string; expiresAt: string } {
  if (!Number.isSafeInteger(input.yuvomiUserId) || input.yuvomiUserId < 1
    || !Number.isSafeInteger(input.amountCents) || input.amountCents < 1
    || !(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
    throw new Error('GiroCode test asset is invalid.');
  }
  const imageToken = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const browserToken = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(input.now.getTime() + TTL_MS).toISOString();
  database.prepare(`
    INSERT INTO girocode_test_assets (
      yuvomi_user_id, image_token_hash, browser_token_hash, payload_encrypted,
      beneficiary_name, iban_masked, amount_cents, remittance, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.yuvomiUserId, tokenHash(imageToken), tokenHash(browserToken),
    (input.encryption ?? createEncryptionService()).encrypt(input.payload), input.beneficiaryName,
    input.ibanMasked, input.amountCents, input.remittance, expiresAt, input.now.toISOString());
  return {
    imageToken, browserToken,
    imagePath: `/api/extensions/banking/push/girocode-test-images/${imageToken}`,
    expiresAt
  };
}

export function findGiroCodeTestImage(database: DatabaseSync, token: string, now = new Date(), encryption = createEncryptionService()): GiroCodeTestAsset | null {
  return findAsset(database, 'image_token_hash', token, now, encryption);
}

export function findOwnedGiroCodeTestView(database: DatabaseSync, yuvomiUserId: number, token: string, now = new Date(), encryption = createEncryptionService()): GiroCodeTestAsset | null {
  const asset = findAsset(database, 'browser_token_hash', token, now, encryption);
  return asset?.yuvomiUserId === yuvomiUserId ? asset : null;
}

export function cleanupExpiredGiroCodeTestAssets(database: DatabaseSync, now = new Date()): number {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return 0;
  return Number(database.prepare('DELETE FROM girocode_test_assets WHERE expires_at <= ?').run(now.toISOString()).changes);
}

function findAsset(database: DatabaseSync, tokenColumn: 'image_token_hash' | 'browser_token_hash', token: string, now: Date, encryption: EncryptionService): GiroCodeTestAsset | null {
  if (!TOKEN_PATTERN.test(token) || !(now instanceof Date) || Number.isNaN(now.getTime())) return null;
  const row = database.prepare(`SELECT * FROM girocode_test_assets WHERE ${tokenColumn} = ? AND expires_at > ? LIMIT 1`)
    .get(tokenHash(token), now.toISOString()) as Record<string, unknown> | undefined;
  if (!row) return null;
  try {
    return {
      id: Number(row.id), yuvomiUserId: Number(row.yuvomi_user_id),
      payload: encryption.decrypt(String(row.payload_encrypted)), beneficiaryName: String(row.beneficiary_name),
      ibanMasked: String(row.iban_masked), amountCents: Number(row.amount_cents), currency: 'EUR',
      remittance: String(row.remittance), expiresAt: String(row.expires_at)
    };
  } catch { return null; }
}

function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

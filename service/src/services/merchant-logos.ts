import fs from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { merchantByKey } from './merchants.js';

const MAX_LOGO_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 8_000;

export class MerchantLogoNotFoundError extends Error {}
export class MerchantLogoFetchError extends Error {}

export interface MerchantLogoResult {
  key: string;
  contentType: string;
  content: Buffer;
}

export async function cacheMerchantLogosForAccount(
  database: DatabaseSync,
  accountId: number,
  options: MerchantLogoOptions = {}
): Promise<{ cached: number; unavailable: number }> {
  if (!Number.isSafeInteger(accountId) || accountId < 1) {
    throw new MerchantLogoNotFoundError('Bank account was not found.');
  }
  const keys = database.prepare(`
    SELECT DISTINCT merchant_key FROM transactions
    WHERE account_id = ? AND merchant_key IS NOT NULL
    ORDER BY merchant_key
  `).all(accountId) as Array<{ merchant_key: string }>;
  let cached = 0;
  let unavailable = 0;
  for (const row of keys) {
    try {
      await ensureMerchantLogo(database, row.merchant_key, options);
      cached += 1;
    } catch (error) {
      if (error instanceof MerchantLogoNotFoundError || error instanceof MerchantLogoFetchError) {
        unavailable += 1;
        continue;
      }
      throw error;
    }
  }
  return { cached, unavailable };
}

export async function ensureMerchantLogo(
  database: DatabaseSync,
  merchantKey: string,
  options: MerchantLogoOptions = {}
): Promise<MerchantLogoResult> {
  const definition = merchantByKey(merchantKey);
  if (!definition) throw new MerchantLogoNotFoundError('Merchant is not in the logo registry.');
  const cacheDirectory = path.resolve(options.cacheDirectory ?? config.merchantLogoCacheDir);
  const cached = await loadCachedMerchantLogo(database, definition.key, cacheDirectory);
  if (cached) return cached;

  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const source = trustedSourceUrl(definition.logoUrl, definition.sourceDomain);
    const response = await fetcher(source, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: { accept: 'image/png,image/jpeg,image/webp,image/x-icon' }
    });
    if (!response.ok || response.redirected) {
      throw new MerchantLogoFetchError('Merchant logo is unavailable.');
    }
    const contentType = allowedContentType(response.headers.get('content-type'));
    if (!contentType) throw new MerchantLogoFetchError('Merchant logo has an unsupported type.');
    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader !== null) {
      const declaredLength = Number(contentLengthHeader);
      if (!Number.isSafeInteger(declaredLength) || declaredLength < 1 || declaredLength > MAX_LOGO_BYTES) {
        throw new MerchantLogoFetchError('Merchant logo is too large.');
      }
    }
    const content = Buffer.from(await response.arrayBuffer());
    if (content.length === 0 || content.length > MAX_LOGO_BYTES || !hasExpectedSignature(content, contentType)) {
      throw new MerchantLogoFetchError('Merchant logo content is invalid.');
    }
    const filePath = cachePath(cacheDirectory, definition.key, contentType);
    await fs.mkdir(cacheDirectory, { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryPath, content, { flag: 'wx' });
    await fs.rename(temporaryPath, filePath);
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO merchant_logos (
        logo_key, merchant_name, source_domain, file_path, content_type, fetched_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(logo_key) DO UPDATE SET
        merchant_name = excluded.merchant_name,
        source_domain = excluded.source_domain,
        file_path = excluded.file_path,
        content_type = excluded.content_type,
        fetched_at = excluded.fetched_at,
        updated_at = excluded.updated_at
    `).run(
      definition.key,
      definition.name,
      definition.sourceDomain,
      filePath,
      contentType,
      now,
      now
    );
    return { key: definition.key, contentType, content };
  } catch (error) {
    if (error instanceof MerchantLogoFetchError || error instanceof MerchantLogoNotFoundError) throw error;
    throw new MerchantLogoFetchError('Merchant logo is unavailable.');
  } finally {
    clearTimeout(timeout);
  }
}

export async function readMerchantLogo(
  database: DatabaseSync,
  merchantKey: string,
  cacheDirectory = config.merchantLogoCacheDir
): Promise<MerchantLogoResult> {
  const definition = merchantByKey(merchantKey);
  if (!definition) throw new MerchantLogoNotFoundError('Merchant is not in the logo registry.');
  const cached = await loadCachedMerchantLogo(database, definition.key, path.resolve(cacheDirectory));
  if (!cached) throw new MerchantLogoNotFoundError('Merchant logo was not cached.');
  return cached;
}

export interface MerchantLogoOptions {
  cacheDirectory?: string;
  fetcher?: typeof fetch;
}

async function loadCachedMerchantLogo(
  database: DatabaseSync,
  merchantKey: string,
  cacheDirectory: string
): Promise<MerchantLogoResult | null> {
  const row = database.prepare(`
    SELECT file_path, content_type FROM merchant_logos WHERE logo_key = ? LIMIT 1
  `).get(merchantKey) as { file_path: string | null; content_type: string | null } | undefined;
  const contentType = allowedContentType(row?.content_type ?? null);
  if (!row?.file_path || !contentType || !isSafeCachePath(row.file_path, cacheDirectory, merchantKey, contentType)) {
    return null;
  }
  try {
    const content = await fs.readFile(row.file_path);
    if (content.length === 0 || content.length > MAX_LOGO_BYTES || !hasExpectedSignature(content, contentType)) {
      return null;
    }
    return { key: merchantKey, contentType, content };
  } catch {
    return null;
  }
}

function trustedSourceUrl(value: string, expectedDomain: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:'
    || url.port
    || url.username
    || url.password
    || url.hostname.toLowerCase() !== expectedDomain.toLowerCase()
  ) {
    throw new MerchantLogoFetchError('Merchant logo source is not trusted.');
  }
  return url.toString();
}

function allowedContentType(value: string | null): string | null {
  const type = value?.split(';', 1)[0].trim().toLowerCase();
  return type === 'image/png' || type === 'image/jpeg' || type === 'image/webp'
    || type === 'image/x-icon' || type === 'image/vnd.microsoft.icon'
    ? type
    : null;
}

function hasExpectedSignature(content: Buffer, contentType: string): boolean {
  if (contentType === 'image/png') {
    return content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (contentType === 'image/jpeg') return content[0] === 0xff && content[1] === 0xd8;
  if (contentType === 'image/webp') return content.subarray(0, 4).equals(Buffer.from('RIFF'))
    && content.subarray(8, 12).equals(Buffer.from('WEBP'));
  return content.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]));
}

function cachePath(cacheDirectory: string, merchantKey: string, contentType: string): string {
  const extension = contentType === 'image/png' ? 'png'
    : contentType === 'image/jpeg' ? 'jpg'
      : contentType === 'image/webp' ? 'webp'
        : 'ico';
  return path.join(cacheDirectory, `${merchantKey}.${extension}`);
}

function isSafeCachePath(
  filePath: string,
  cacheDirectory: string,
  merchantKey: string,
  contentType: string
): boolean {
  const expected = cachePath(cacheDirectory, merchantKey, contentType);
  return path.resolve(filePath) === path.resolve(expected);
}

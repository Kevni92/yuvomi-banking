import type { DatabaseSync } from 'node:sqlite';

export interface MerchantDefinition {
  key: string;
  name: string;
  sourceDomain: string;
  logoUrl: string;
  aliases: string[];
}

export const MERCHANT_REGISTRY: readonly MerchantDefinition[] = [
  merchant('lidl', 'Lidl', 'www.lidl.de', ['LIDL']),
  merchant('rewe', 'REWE', 'www.rewe.de', ['REWE']),
  merchant('aldi', 'ALDI', 'www.aldi-sued.de', ['ALDI', 'ALDI SÜD', 'ALDI NORD']),
  merchant('edeka', 'EDEKA', 'www.edeka.de', ['EDEKA']),
  merchant('dm', 'dm', 'www.dm.de', ['DM DROGERIE', 'DM MARKT', 'DROGERIEMARKT DM']),
  merchant('rossmann', 'ROSSMANN', 'www.rossmann.de', ['ROSSMANN']),
  merchant('netflix', 'Netflix', 'www.netflix.com', ['NETFLIX']),
  merchant('spotify', 'Spotify', 'www.spotify.com', ['SPOTIFY']),
  merchant('amazon', 'Amazon', 'www.amazon.de', ['AMAZON', 'AMZN']),
  merchant('uber', 'Uber', 'www.uber.com', ['UBER'])
];

export interface NormalizedMerchant {
  key: string;
  name: string;
}

/** Returns a known, local registry identity without making a network request. */
export function normalizeMerchant(...values: Array<string | null | undefined>): NormalizedMerchant | null {
  const haystack = values
    .filter((value): value is string => typeof value === 'string')
    .map(normalizeForMatch)
    .filter(Boolean)
    .join(' ');
  if (!haystack) return null;
  for (const merchant of MERCHANT_REGISTRY) {
    if (merchant.aliases.some((alias) => containsAlias(haystack, normalizeForMatch(alias)))) {
      return { key: merchant.key, name: merchant.name };
    }
  }
  return null;
}

export function merchantByKey(key: string): MerchantDefinition | null {
  return MERCHANT_REGISTRY.find((merchant) => merchant.key === key) ?? null;
}

/** Makes later imports and existing records agree without promoting unknown people to merchants. */
export function normalizeMerchantsForAccount(
  database: DatabaseSync,
  accountId: number,
  now = new Date()
): number {
  if (!Number.isSafeInteger(accountId) || accountId < 1 || Number.isNaN(now.getTime())) {
    throw new Error('Merchant normalization input is invalid.');
  }
  const rows = database.prepare(`
    SELECT id, merchant_name, counterparty_name, purpose
    FROM transactions WHERE account_id = ?
  `).all(accountId) as Array<{
    id: number;
    merchant_name: string | null;
    counterparty_name: string | null;
    purpose: string | null;
  }>;
  const update = database.prepare(`
    UPDATE transactions SET merchant_key = ?, merchant_name = ?, updated_at = ? WHERE id = ?
  `);
  let normalized = 0;
  const timestamp = now.toISOString();
  for (const row of rows) {
    const merchant = normalizeMerchant(row.merchant_name, row.counterparty_name, row.purpose);
    if (!merchant) continue;
    const result = update.run(merchant.key, merchant.name, timestamp, row.id);
    normalized += Number(result.changes);
  }
  return normalized;
}

function merchant(key: string, name: string, sourceDomain: string, aliases: string[]): MerchantDefinition {
  return {
    key,
    name,
    sourceDomain,
    logoUrl: `https://${sourceDomain}/favicon.ico`,
    aliases
  };
}

function normalizeForMatch(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

function containsAlias(value: string, alias: string): boolean {
  return Boolean(alias) && (` ${value} `).includes(` ${alias} `);
}

import type { DatabaseSync } from 'node:sqlite';
import type { EncryptionService } from '../security/encryption.js';
import { readStoredProviderPayload } from './provider-transaction-payload.js';
import { collectTransactionEvidence, type TransactionEvidence } from './transaction-evidence.js';

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

export interface ResolvedMerchant {
  merchant: NormalizedMerchant;
  source: string;
  method: 'provider_explicit' | 'registry_alias';
}

export function resolveMerchantFromEvidence(evidence: TransactionEvidence[]): ResolvedMerchant | null {
  for (const strength of ['strong', 'medium', 'weak'] as const) {
    for (const item of evidence.filter((candidate) => candidate.strength === strength)) {
      const merchant = normalizeMerchant(item.value);
      if (!merchant) continue;
      return {
        merchant,
        source: item.source,
        method: strength === 'strong' && /merchant(_name|\.name)?$|card_acceptor_name$/.test(item.source)
          ? 'provider_explicit' : 'registry_alias'
      };
    }
  }
  return null;
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
  now = new Date(),
  encryption?: EncryptionService
): number {
  if (!Number.isSafeInteger(accountId) || accountId < 1 || Number.isNaN(now.getTime())) {
    throw new Error('Merchant normalization input is invalid.');
  }
  const rows = database.prepare(`
    SELECT id, merchant_name, counterparty_name, purpose, raw_payload_encrypted,
           merchant_resolution_method
    FROM transactions WHERE account_id = ?
  `).all(accountId) as Array<{
    id: number;
    merchant_name: string | null;
    counterparty_name: string | null;
    purpose: string | null;
    raw_payload_encrypted: string | null;
    merchant_resolution_method: string | null;
  }>;
  const update = database.prepare(`
    UPDATE transactions SET merchant_key = ?, merchant_name = ?, merchant_evidence_source = ?,
      merchant_resolution_method = ?, updated_at = ? WHERE id = ?
  `);
  let normalized = 0;
  const timestamp = now.toISOString();
  for (const row of rows) {
    if (row.merchant_resolution_method === 'manual') continue;
    const payload = encryption ? readStoredProviderPayload(row.raw_payload_encrypted, encryption) : null;
    const evidence: TransactionEvidence[] = [
      ...(row.merchant_name ? [{ source: 'normalized.merchant_name', value: row.merchant_name, strength: 'strong' as const }] : []),
      ...(row.counterparty_name ? [{ source: 'normalized.counterparty_name', value: row.counterparty_name, strength: 'strong' as const }] : []),
      ...(row.purpose ? [{ source: 'normalized.purpose', value: row.purpose, strength: 'medium' as const }] : []),
      ...(payload ? collectTransactionEvidence(payload.list, payload.detail) : [])
    ];
    const resolved = resolveMerchantFromEvidence(evidence);
    if (!resolved) continue;
    const result = update.run(
      resolved.merchant.key, resolved.merchant.name, resolved.source, resolved.method, timestamp, row.id
    );
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

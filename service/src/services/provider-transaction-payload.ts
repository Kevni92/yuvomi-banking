import type { EncryptionService } from '../security/encryption.js';

export interface StoredProviderTransactionPayloadV1 {
  version: 1;
  list: Record<string, unknown>;
  detail: Record<string, unknown> | null;
  list_fetched_at: string;
  detail_fetched_at: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Reads both the v1 envelope and payloads written before enrichment existed. */
export function readStoredProviderPayload(
  encrypted: unknown,
  encryption: EncryptionService
): StoredProviderTransactionPayloadV1 | null {
  if (typeof encrypted !== 'string' || !encrypted) return null;
  try {
    const parsed: unknown = JSON.parse(encryption.decrypt(encrypted));
    if (isRecord(parsed) && parsed.version === 1 && isRecord(parsed.list)
      && (parsed.detail === null || isRecord(parsed.detail))
      && typeof parsed.list_fetched_at === 'string'
      && (parsed.detail_fetched_at === null || typeof parsed.detail_fetched_at === 'string')) {
      return parsed as unknown as StoredProviderTransactionPayloadV1;
    }
    if (isRecord(parsed)) {
      return { version: 1, list: parsed, detail: null, list_fetched_at: '', detail_fetched_at: null };
    }
  } catch {
    // A corrupt historical payload must not prevent importing other records.
  }
  return null;
}

export function mergeListPayload(
  existing: StoredProviderTransactionPayloadV1 | null,
  list: Record<string, unknown>,
  fetchedAt: string
): StoredProviderTransactionPayloadV1 {
  return {
    version: 1,
    list,
    detail: existing?.detail ?? null,
    list_fetched_at: fetchedAt,
    detail_fetched_at: existing?.detail_fetched_at ?? null
  };
}

export function mergeDetailPayload(
  existing: StoredProviderTransactionPayloadV1 | null,
  detail: Record<string, unknown>,
  fetchedAt: string
): StoredProviderTransactionPayloadV1 {
  return {
    version: 1,
    list: existing?.list ?? {},
    detail,
    list_fetched_at: existing?.list_fetched_at ?? '',
    detail_fetched_at: fetchedAt
  };
}

export function writeStoredProviderPayload(
  payload: StoredProviderTransactionPayloadV1,
  encryption: EncryptionService
): string {
  return encryption.encrypt(JSON.stringify(payload));
}

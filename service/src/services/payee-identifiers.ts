import crypto from 'node:crypto';
import { normalizeIban } from './counterparty.js';
import { isPaymentProcessor, isTechnicalPaymentParty } from './payment-intermediaries.js';

export type PayeeIdentifierType =
  | 'sepa_creditor_id'
  | 'counterparty_iban'
  | 'account_additional_id'
  | 'merchant_key'
  | 'resolved_merchant_name'
  | 'counterparty_name';

export type PayeeIdentifierStrength = 'strong' | 'candidate';

export interface PayeeIdentifierEvidence {
  identifierType: PayeeIdentifierType;
  normalizedValue: string;
  strength: PayeeIdentifierStrength;
  source: string;
  displayName?: string | null;
}

export interface PayeeIdentifierExtractionInput {
  counterpartyId?: string | null;
  counterpartyName?: string | null;
  merchantName?: string | null;
  merchantKey?: string | null;
  paymentMethod?: string | null;
  resolutionEntityType?: 'merchant' | 'own_transfer' | 'counterparty' | null;
  resolutionDisplayName?: string | null;
  providerRecords?: Array<Record<string, unknown>>;
}

const MAX_IDENTIFIER_LENGTH = 256;
const ADDITIONAL_ID_SCHEMES = new Set([
  'IBAN', 'BBAN', 'ACCOUNTNUMBER', 'ACCOUNT_NUMBER', 'BANK_ACCOUNT_NUMBER'
]);

/**
 * Returns a stable comparison value for a supported identifier, or null when
 * the provider value is malformed or the scheme is not explicitly allowed.
 */
export function normalizePayeeIdentifier(
  identifierType: PayeeIdentifierType,
  value: unknown
): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_IDENTIFIER_LENGTH) return null;
  if (identifierType === 'counterparty_iban') {
    const iban = normalizeIban(value);
    return /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban) ? iban : null;
  }
  if (identifierType === 'merchant_key') {
    const key = value.normalize('NFKC').trim().toLowerCase();
    return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(key) ? key : null;
  }
  if (identifierType === 'sepa_creditor_id') {
    const id = compactIdentifier(value);
    return /^[A-Z]{2}\d{2}[A-Z0-9]{3,31}$/.test(id) ? id : null;
  }
  if (identifierType === 'account_additional_id') {
    return compactIdentifier(value) || null;
  }
  return normalizeComparisonName(value);
}

/** Domain-separated HMAC for all new identifier types. */
export function hashPayeeIdentifier(
  identifierType: PayeeIdentifierType,
  normalizedValue: string,
  secret: string
): string {
  if (!secret.trim()) throw new Error('COUNTERPARTY_HMAC_SECRET is not configured.');
  if (!normalizedValue || normalizedValue.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error('Payee identifier is invalid.');
  }
  return crypto.createHmac('sha256', secret)
    .update(`payee:v1:${identifierType}:${normalizedValue}`, 'utf8')
    .digest('hex');
}

/** Compatibility hash for the already persisted counterparty HMAC. */
export function counterpartyIdentifierHash(value: string): string {
  return value.trim();
}

/**
 * Extracts only allowlisted, deterministic identity evidence. This function
 * never logs, accesses the network, or returns provider payloads.
 */
export function extractPayeeIdentifiers(
  input: PayeeIdentifierExtractionInput
): PayeeIdentifierEvidence[] {
  const result: PayeeIdentifierEvidence[] = [];
  const add = (
    identifierType: PayeeIdentifierType,
    value: unknown,
    strength: PayeeIdentifierStrength,
    source: string,
    displayName?: string | null
  ) => {
    const normalizedValue = normalizePayeeIdentifier(identifierType, value);
    if (!normalizedValue || !source || result.some((item) =>
      item.identifierType === identifierType && item.normalizedValue === normalizedValue
    )) return;
    result.push({ identifierType, normalizedValue, strength, source, displayName: displayName ?? null });
  };

  const counterpartyIsUseful = !input.counterpartyName || !isRejectedName(input.counterpartyName);
  if (input.counterpartyId?.trim() && counterpartyIsUseful) {
    // The legacy counterparty_id is already the compatibility HMAC and must
    // not be re-hashed without the legacy domain.
    result.push({
      identifierType: 'counterparty_iban',
      normalizedValue: `legacy:${input.counterpartyId.trim()}`,
      strength: 'strong',
      source: 'counterparty.counterparty_id',
      displayName: input.counterpartyName ?? null
    });
  }

  for (const record of input.providerRecords ?? []) {
    const creditor = recordValue(record.creditor);
    const creditorAccount = recordValue(record.creditor_account);
    if (!text(creditor?.name) || !isRejectedName(text(creditor?.name) as string)) {
      add('counterparty_iban', creditorAccount?.iban, 'strong', 'provider.creditor_account.iban', text(creditor?.name));
    }
    addExplicitCreditorId(record, add);
    const additional = record.creditor_account_additional_identification;
    const additionalId = additionalIdentifier(additional);
    if (additionalId) {
      add('account_additional_id', additionalId.value, additionalId.strength, 'provider.creditor_account_additional_identification', text(creditor?.name));
    }
  }

  if (input.merchantKey && input.resolutionEntityType !== 'own_transfer') {
    add('merchant_key', input.merchantKey, 'strong', 'resolution.merchant_key', input.resolutionDisplayName ?? input.merchantName);
  }

  const resolvedName = input.resolutionEntityType === 'merchant'
    ? input.resolutionDisplayName ?? input.merchantName
    : null;
  if (resolvedName && !isRejectedName(resolvedName)) {
    add('resolved_merchant_name', scopedName(input.paymentMethod, resolvedName), 'candidate', 'resolution.merchant_name', resolvedName);
  }

  if (input.counterpartyName && !isRejectedName(input.counterpartyName)) {
    add('counterparty_name', scopedName(input.paymentMethod, input.counterpartyName), 'candidate', 'provider.counterparty_name', input.counterpartyName);
  }

  // A labelled creditor ID may be present in a remittance field rather than a
  // structured provider property. Generic opaque strings are intentionally not
  // accepted here.
  for (const record of input.providerRecords ?? []) {
    for (const purpose of purposeValues(record.remittance_information)) {
      const value = labelledCreditorId(purpose);
      if (value) add('sepa_creditor_id', value, 'strong', 'provider.remittance_information.creditor_id', input.counterpartyName);
    }
  }

  return result;
}

export function normalizeComparisonName(value: string): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_IDENTIFIER_LENGTH) return null;
  const normalized = value.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  return normalized || null;
}

function addExplicitCreditorId(
  record: Record<string, unknown>,
  add: (type: PayeeIdentifierType, value: unknown, strength: PayeeIdentifierStrength, source: string, displayName?: string | null) => void
): void {
  for (const key of ['sepa_creditor_id', 'creditor_id', 'creditor_identifier', 'creditor_identification', 'sepaCreditorId']) {
    const value = text(record[key]);
    if (value) add('sepa_creditor_id', value, 'strong', `provider.${key}`, text(recordValue(record.creditor)?.name));
  }
}

function labelledCreditorId(value: string): string | null {
  const match = /(?:gl[aä]ubiger(?:-?identifikationsnummer)?|creditor\s*(?:identifier|id))\s*[:#=\-]?\s*([A-Z]{2}\d{2}[A-Z0-9]{3,31})\b/i.exec(value);
  return match?.[1] ?? null;
}

function additionalIdentifier(value: unknown): { value: string; strength: PayeeIdentifierStrength } | null {
  const record = recordValue(value);
  if (!record) return null;
  const scheme = text(record.scheme_name ?? record.schemeName)?.replace(/[^a-z0-9_]/gi, '').toUpperCase();
  const identification = text(record.identification);
  if (!scheme || !identification || !ADDITIONAL_ID_SCHEMES.has(scheme)) return null;
  const normalized = normalizePayeeIdentifier('account_additional_id', `${scheme}:${identification}`);
  return normalized ? { value: normalized, strength: scheme === 'IBAN' ? 'strong' : 'candidate' } : null;
}

function scopedName(paymentMethod: string | null | undefined, value: string): string | null {
  const normalized = normalizeComparisonName(value);
  return normalized ? `${normalizeComparisonName(paymentMethod || 'UNKNOWN') || 'UNKNOWN'}:${normalized}` : null;
}

function isRejectedName(value: string): boolean {
  return isPaymentProcessor(value) || isTechnicalPaymentParty(value) || !normalizeComparisonName(value);
}

function compactIdentifier(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '').toUpperCase().slice(0, MAX_IDENTIFIER_LENGTH);
}

function purposeValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 2_000));
  return typeof value === 'string' ? [value.slice(0, 2_000)] : [];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_IDENTIFIER_LENGTH) : null;
}

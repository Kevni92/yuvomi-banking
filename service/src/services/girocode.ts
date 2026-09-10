import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import QRCode from 'qrcode';
import { createEncryptionService } from '../security/encryption.js';
import { maskIban, normalizeIban } from './counterparty.js';

const MAX_EPC_PAYLOAD_BYTES = 331;
const MAX_EPC_QR_VERSION = 13;
const MAX_EPC_AMOUNT_CENTS = 99_999_999_999;

export interface GiroCodePaymentInput {
  beneficiaryName: string;
  iban: string;
  amountCents: number;
  remittance: string;
  bic?: string | null;
}

export interface WeeklyBudgetGiroCode {
  suggestionId: number;
  revision: number;
  periodKey: string;
  status: string;
  beneficiaryName: string;
  ibanMasked: string;
  amountCents: number;
  currency: 'EUR';
  purpose: string;
  payload: string;
  payloadSha256: string;
}

export class GiroCodeNotFoundError extends Error {}
export class GiroCodeUnavailableError extends Error {}

export function buildEpcQrPayload(input: GiroCodePaymentInput): string {
  const beneficiaryName = normalizedText(input.beneficiaryName, 'Beneficiary name', 70);
  const iban = assertValidIban(input.iban);
  const amount = epcEuroAmount(input.amountCents);
  const remittance = normalizedText(input.remittance, 'Remittance information', 140);
  const bic = normalizedBic(input.bic);
  const payload = [
    'BCD',
    '002',
    '1',
    'SCT',
    bic,
    beneficiaryName,
    iban,
    amount,
    '',
    '',
    remittance
  ].join('\n');

  if (Buffer.byteLength(payload, 'utf8') > MAX_EPC_PAYLOAD_BYTES) {
    throw new GiroCodeUnavailableError('GiroCode payload exceeds 331 UTF-8 bytes.');
  }
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
  if (qr.version > MAX_EPC_QR_VERSION) {
    throw new GiroCodeUnavailableError('GiroCode requires a QR version above 13.');
  }
  return payload;
}

export function giroCodePayloadSha256(payload: string): string {
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

export async function renderGiroCodePng(payload: string): Promise<Buffer> {
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new GiroCodeUnavailableError('GiroCode payload is missing.');
  }
  if (Buffer.byteLength(payload, 'utf8') > MAX_EPC_PAYLOAD_BYTES) {
    throw new GiroCodeUnavailableError('GiroCode payload exceeds 331 UTF-8 bytes.');
  }
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
  if (qr.version > MAX_EPC_QR_VERSION) {
    throw new GiroCodeUnavailableError('GiroCode requires a QR version above 13.');
  }
  return QRCode.toBuffer(payload, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 4,
    scale: 8
  });
}

export function loadWeeklyBudgetGiroCode(
  database: DatabaseSync,
  yuvomiUserId: number,
  suggestionId: number
): WeeklyBudgetGiroCode {
  if (!Number.isSafeInteger(suggestionId) || suggestionId < 1) {
    throw new GiroCodeNotFoundError('Transfer suggestion was not found.');
  }
  const row = database.prepare(`
    SELECT transfer_suggestions.id, transfer_suggestions.revision,
           transfer_suggestions.computed_amount_cents,
           transfer_suggestions.purpose, transfer_suggestions.status,
           transfer_suggestions.payload_sha256,
           weekly_budget_periods.period_key,
           weekly_budget_periods.target_beneficiary_name,
           weekly_budget_periods.target_account_name,
           weekly_budget_periods.target_iban_encrypted,
           weekly_budget_periods.currency
    FROM transfer_suggestions
    JOIN weekly_budget_periods
      ON weekly_budget_periods.id = transfer_suggestions.period_id
    JOIN weekly_budget_configs
      ON weekly_budget_configs.id = weekly_budget_periods.config_id
    WHERE transfer_suggestions.id = ?
      AND weekly_budget_configs.yuvomi_user_id = ?
    LIMIT 1
  `).get(suggestionId, yuvomiUserId) as Record<string, unknown> | undefined;
  if (!row) throw new GiroCodeNotFoundError('Transfer suggestion was not found.');

  const amountCents = Number(row.computed_amount_cents);
  if (!Number.isSafeInteger(amountCents) || amountCents < 1) {
    throw new GiroCodeUnavailableError('No GiroCode is generated for a zero transfer.');
  }
  if (row.status === 'dismissed' || row.status === 'superseded' || row.status === 'failed') {
    throw new GiroCodeUnavailableError('GiroCode is unavailable for an inactive transfer suggestion.');
  }
  if (row.currency !== 'EUR') {
    throw new GiroCodeUnavailableError('GiroCode transfer currency must be EUR.');
  }
  const encryptedIban = typeof row.target_iban_encrypted === 'string'
    ? row.target_iban_encrypted
    : '';
  const rawBeneficiaryName = typeof row.target_beneficiary_name === 'string'
    ? row.target_beneficiary_name
    : typeof row.target_account_name === 'string'
      ? row.target_account_name
      : '';
  const beneficiaryName = normalizedText(rawBeneficiaryName, 'Beneficiary name', 70);
  const purpose = typeof row.purpose === 'string' ? row.purpose : '';
  if (!encryptedIban) {
    throw new GiroCodeUnavailableError('Target-account IBAN snapshot is unavailable.');
  }

  let iban: string;
  try {
    iban = createEncryptionService().decrypt(encryptedIban);
  } catch {
    throw new GiroCodeUnavailableError('Target-account IBAN snapshot cannot be decrypted.');
  }
  const payload = buildEpcQrPayload({
    beneficiaryName,
    iban,
    amountCents,
    remittance: purpose
  });
  const payloadSha256 = giroCodePayloadSha256(payload);
  if (
    typeof row.payload_sha256 === 'string'
    && row.payload_sha256.length > 0
    && !safeHashEqual(row.payload_sha256, payloadSha256)
  ) {
    throw new GiroCodeUnavailableError('Stored GiroCode payload fingerprint does not match.');
  }

  return {
    suggestionId: Number(row.id),
    revision: Number(row.revision),
    periodKey: String(row.period_key),
    status: String(row.status),
    beneficiaryName,
    ibanMasked: maskIban(iban),
    amountCents,
    currency: 'EUR',
    purpose,
    payload,
    payloadSha256
  };
}

export function assertValidIban(value: string): string {
  const iban = normalizeIban(value);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban) || iban.length > 34) {
    throw new GiroCodeUnavailableError('Beneficiary IBAN is invalid.');
  }
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  let remainder = 0;
  for (const character of rearranged) {
    const digits = /[A-Z]/.test(character)
      ? String(character.charCodeAt(0) - 55)
      : character;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  if (remainder !== 1) throw new GiroCodeUnavailableError('Beneficiary IBAN checksum is invalid.');
  return iban;
}

function normalizedText(value: string, label: string, maximumCharacters: number): string {
  if (typeof value !== 'string') throw new GiroCodeUnavailableError(`${label} is missing.`);
  const normalized = value.trim().normalize('NFC');
  if (
    normalized.length === 0
    || Array.from(normalized).length > maximumCharacters
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new GiroCodeUnavailableError(`${label} is invalid.`);
  }
  return normalized;
}

function normalizedBic(value: string | null | undefined): string {
  if (value == null || value.trim() === '') return '';
  const bic = value.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)) {
    throw new GiroCodeUnavailableError('Beneficiary BIC is invalid.');
  }
  return bic;
}

function epcEuroAmount(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > MAX_EPC_AMOUNT_CENTS) {
    throw new GiroCodeUnavailableError('GiroCode amount is outside the EPC range.');
  }
  const euros = Math.floor(cents / 100);
  const remainder = String(cents % 100).padStart(2, '0');
  return `EUR${euros}.${remainder}`;
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

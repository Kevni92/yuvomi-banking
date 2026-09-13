import type { DatabaseSync } from 'node:sqlite';
import type { PublicTransaction } from './transactions-query.js';
import type { TransactionSemantics } from './transaction-semantics.js';

export type TransactionTitleMode = 'smart' | 'counterparty' | 'transaction_type';

export interface BankingPresentationSettings {
  transactionTitleMode: TransactionTitleMode;
}

const DEFAULT_SETTINGS: BankingPresentationSettings = {
  transactionTitleMode: 'smart'
};

export function getPresentationSettings(
  database: DatabaseSync,
  yuvomiUserId: number
): BankingPresentationSettings {
  try {
    const row = database.prepare(`
      SELECT transaction_title_mode
      FROM banking_presentation_settings
      WHERE yuvomi_user_id = ?
      LIMIT 1
    `).get(yuvomiUserId) as { transaction_title_mode?: string } | undefined;

    return {
      transactionTitleMode: normalizeTransactionTitleMode(row?.transaction_title_mode)
    };
  } catch (error) {
    // A few isolated readers/tests build only the transaction tables. More
    // importantly, this also makes a rolling deployment safe while migration 22
    // has not been applied yet: presentation is optional and must never break
    // the transaction list.
    if (error instanceof Error && /no such table:\s*banking_presentation_settings/i.test(error.message)) {
      return { ...DEFAULT_SETTINGS };
    }
    throw error;
  }
}

export function savePresentationSettings(
  database: DatabaseSync,
  yuvomiUserId: number,
  transactionTitleMode: unknown,
  now = new Date()
): BankingPresentationSettings {
  const mode = parseTransactionTitleMode(transactionTitleMode);
  const nowIso = now.toISOString();
  database.prepare(`
    INSERT INTO banking_presentation_settings (
      yuvomi_user_id, transaction_title_mode, created_at, updated_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(yuvomi_user_id) DO UPDATE SET
      transaction_title_mode = excluded.transaction_title_mode,
      updated_at = excluded.updated_at
  `).run(yuvomiUserId, mode, nowIso, nowIso);
  return { transactionTitleMode: mode };
}

export function resolveTransactionDisplayTitle(
  transaction: Pick<
    PublicTransaction,
    | 'merchant_name'
    | 'merchant_key'
    | 'merchant_logo_available'
    | 'counterparty_name'
    | 'purpose'
  >,
  semantics: TransactionSemantics,
  mode: TransactionTitleMode
): string | null {
  const merchant = text(transaction.merchant_name);
  const counterparty = text(transaction.counterparty_name);
  const purpose = text(transaction.purpose);
  const specificType = semanticTitle(semantics);
  const merchantIsTechnical = Boolean(merchant && looksTechnicalParty(merchant));
  const counterpartyIsTechnical = Boolean(counterparty && looksTechnicalParty(counterparty));

  // Even the explicit counterparty mode must not promote a settlement bank,
  // card issuer or opaque provider reference to the primary user-facing title
  // when the bank supplies a stronger payment method such as Apple Pay.
  if (mode === 'counterparty') {
    if (merchant && !merchantIsTechnical) return merchant;
    if (counterparty && !counterpartyIsTechnical) return counterparty;
    return specificType || merchant || counterparty || purpose;
  }

  if (mode === 'transaction_type') {
    return specificType || merchant || counterparty || purpose;
  }

  // "Smart" intentionally distinguishes a useful human-facing merchant from
  // technical provider data. A logo/merchant registry must not make an ATM,
  // settlement bank or opaque provider reference win over stronger semantics.
  if (merchant && !merchantIsTechnical) return merchant;
  if (semantics.preferDisplay && specificType) return specificType;
  if (counterparty && !counterpartyIsTechnical) return counterparty;
  return specificType || merchant || counterparty || purpose;
}

export function parseTransactionTitleMode(value: unknown): TransactionTitleMode {
  if (value === 'smart' || value === 'counterparty' || value === 'transaction_type') return value;
  throw new PresentationSettingsValidationError('Unknown transaction title mode.');
}

export class PresentationSettingsValidationError extends Error {}

function normalizeTransactionTitleMode(value: unknown): TransactionTitleMode {
  try {
    return parseTransactionTitleMode(value);
  } catch {
    return DEFAULT_SETTINGS.transactionTitleMode;
  }
}

function semanticTitle(semantics: TransactionSemantics): string | null {
  if (semantics.kind === 'cash_withdrawal') return 'Bargeldauszahlung';
  if (semantics.kind === 'cash_deposit') return 'Bargeldeinzahlung';
  // A wallet/payment method is the strongest useful label when the provider
  // exposes only a settlement bank as counterparty. "Apple Pay" is clearer
  // than the transport description "E-COM (APPLE PAY)".
  if (semantics.kind === 'card_payment' && text(semantics.paymentMethod)) {
    return text(semantics.paymentMethod);
  }
  if (semantics.kind === 'card_payment' && semantics.description) {
    return prettyProviderDescription(semantics.description);
  }
  return text(semantics.displayLabel) || text(semantics.label) || text(semantics.description);
}

function prettyProviderDescription(value: string): string {
  const normalized = value.trim();
  if (/^E[- ]?COM\s*\(APPLE PAY\)$/i.test(normalized)) return 'E-COM (Apple Pay)';
  if (/^E[- ]?COM\s*\(GOOGLE PAY\)$/i.test(normalized)) return 'E-COM (Google Pay)';
  if (/^BARGELDAUSZAHLUNG$/i.test(normalized)) return 'Bargeldauszahlung';
  if (/^BARGELDEINZAHLUNG$/i.test(normalized)) return 'Bargeldeinzahlung';
  return normalized;
}

function looksTechnicalParty(value: string): boolean {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();
  return /\b(LANDESBANK|SPARKASSE|SPK|BANK|ISSUER|PAYMENT SERVICES?|CARD SERVICES?)\b/.test(normalized)
    || /\bGA\s+NR\d+/i.test(value)
    || /\bBLZ\d+/i.test(value)
    || /^MO\s+\d{6,}(?:\s+|$)/i.test(value)
    || /^[A-Z]{1,3}\s+\d{6,}\s+\d{8,}[A-Z0-9]*$/i.test(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

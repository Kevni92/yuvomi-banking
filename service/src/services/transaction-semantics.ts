export type TransactionSemanticKind =
  | 'cash_withdrawal'
  | 'cash_deposit'
  | 'card_payment'
  | 'direct_debit'
  | 'standing_order'
  | 'transfer'
  | 'other';

export interface TransactionSemantics {
  kind: TransactionSemanticKind | null;
  label: string | null;
  description: string | null;
  paymentMethod: string | null;
  displayLabel: string | null;
  preferDisplay: boolean;
  categoryHint: string | null;
}

interface ParsedBankTransactionCode {
  code: string | null;
  subCode: string | null;
  description: string | null;
}

const EMPTY: TransactionSemantics = {
  kind: null,
  label: null,
  description: null,
  paymentMethod: null,
  displayLabel: null,
  preferDisplay: false,
  categoryHint: null
};

/**
 * Turns provider-specific bank transaction codes into stable, user-facing
 * semantics. The provider payload remains the source of truth; these values are
 * derived presentation/categorization hints and therefore require no migration.
 */
export function deriveTransactionSemantics(value: unknown): TransactionSemantics {
  const parsed = parseBankTransactionCode(value);
  if (!parsed.description && !parsed.code && !parsed.subCode) return { ...EMPTY };

  const evidence = normalize([parsed.description, parsed.code, parsed.subCode].filter(Boolean).join(' '));
  const description = parsed.description;
  const paymentMethod = paymentMethodFrom(evidence);

  if (matches(evidence, ['BARGELDAUSZAHLUNG', 'BARGELD AUSZAHLUNG', 'CASH WITHDRAWAL', 'ATM WITHDRAWAL', 'GELDAUTOMAT'])) {
    return semantic('cash_withdrawal', 'Bargeldabhebung', description, null, true, 'Bargeld');
  }
  if (matches(evidence, ['BARGELDEINZAHLUNG', 'BARGELD EINZAHLUNG', 'CASH DEPOSIT', 'ATM DEPOSIT'])) {
    return semantic('cash_deposit', 'Bargeldeinzahlung', description, null, true, 'Bargeld');
  }
  if (matches(evidence, ['DAUERAUFTRAG', 'STANDING ORDER'])) {
    return semantic('standing_order', 'Dauerauftrag', description, null, false, null);
  }
  if (matches(evidence, ['LASTSCHRIFT', 'DIRECT DEBIT', 'SEPA DD'])) {
    return semantic('direct_debit', 'Lastschrift', description, null, false, null);
  }
  if (
    paymentMethod
    || matches(evidence, ['E COM', 'ECOM', 'KARTENZAHLUNG', 'CARD PAYMENT', 'DEBITKARTE', 'CREDIT CARD', 'MASTERCARD', 'VISA'])
  ) {
    return semantic('card_payment', 'Kartenzahlung', description, paymentMethod, true, null);
  }
  if (matches(evidence, ['UBERWEISUNG', 'UEBERWEISUNG', 'CREDIT TRANSFER', 'SEPA TRANSFER', 'BANK TRANSFER'])) {
    return semantic('transfer', 'Überweisung', description, null, false, null);
  }

  return {
    kind: 'other',
    label: description,
    description,
    paymentMethod,
    displayLabel: paymentMethod || description,
    preferDisplay: false,
    categoryHint: null
  };
}

export function parseBankTransactionCode(value: unknown): ParsedBankTransactionCode {
  let raw = value;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return { code: null, subCode: null, description: null };
    try {
      raw = JSON.parse(trimmed) as unknown;
    } catch {
      return { code: null, subCode: null, description: trimmed.slice(0, 2_000) };
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { code: null, subCode: null, description: null };
  }
  const record = raw as Record<string, unknown>;
  return {
    code: text(record.code),
    subCode: text(record.sub_code ?? record.subCode),
    description: text(record.description)
  };
}

function semantic(
  kind: TransactionSemanticKind,
  label: string,
  description: string | null,
  paymentMethod: string | null,
  preferDisplay: boolean,
  categoryHint: string | null
): TransactionSemantics {
  return {
    kind,
    label,
    description,
    paymentMethod,
    displayLabel: paymentMethod ? `${label} · ${paymentMethod}` : label,
    preferDisplay,
    categoryHint
  };
}

function paymentMethodFrom(evidence: string): string | null {
  if (evidence.includes('APPLE PAY')) return 'Apple Pay';
  if (evidence.includes('GOOGLE PAY')) return 'Google Pay';
  return null;
}

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matches(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(normalize(needle)));
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 2_000) : null;
}

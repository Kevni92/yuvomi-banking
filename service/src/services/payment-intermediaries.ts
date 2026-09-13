export type PaymentIntermediaryKind = 'processor' | 'technical_party';

export interface PaymentIntermediary {
  name: string;
  kind: PaymentIntermediaryKind;
}

const PROCESSORS: ReadonlyArray<{ name: string; patterns: RegExp[] }> = [
  { name: 'PayPal', patterns: [/\bPAYPAL\b/i] },
  { name: 'Klarna', patterns: [/\bKLARNA\b/i] },
  { name: 'Stripe', patterns: [/\bSTRIPE\b/i] },
  { name: 'Adyen', patterns: [/\bADYEN\b/i] },
  { name: 'Mollie', patterns: [/\bMOLLIE\b/i] },
  { name: 'SumUp', patterns: [/\bSUMUP\b/i] }
];

/**
 * Payment processors are useful context but are not merchants. A PayPal
 * counterparty, for example, must never become a reusable merchant identity.
 */
export function detectPaymentIntermediary(
  ...values: Array<string | null | undefined>
): PaymentIntermediary | null {
  for (const value of values) {
    if (!value) continue;
    for (const processor of PROCESSORS) {
      if (processor.patterns.some((pattern) => pattern.test(value))) {
        return { name: processor.name, kind: 'processor' };
      }
    }
    if (isTechnicalPaymentParty(value)) {
      return { name: value.trim().slice(0, 200), kind: 'technical_party' };
    }
  }
  return null;
}

/**
 * Detects structurally technical provider values, not institution names.
 *
 * Deliberately do not classify a party just because its name contains "Bank",
 * "Sparkasse" or a particular institution name. A bank can be a legitimate
 * payee. Whether a counterparty should lose to card/wallet semantics is decided
 * from transaction evidence in the presentation resolver instead.
 */
export function isTechnicalPaymentParty(value: string | null | undefined): boolean {
  if (!value || !value.trim()) return false;
  const normalized = normalize(value);
  return /^(?:ISSUER|CARD SERVICES?|PAYMENT SERVICES?)$/.test(normalized)
    || /\bGA\s+NR\d+/i.test(value)
    || /\bBLZ\d+/i.test(value)
    || /^MO\s+\d{6,}(?:\s+|$)/i.test(value)
    || /^[A-Z]{1,3}\s+\d{6,}\s+\d{8,}[A-Z0-9]*$/i.test(value);
}

export function isPaymentProcessor(value: string | null | undefined): boolean {
  if (!value) return false;
  return PROCESSORS.some((processor) => processor.patterns.some((pattern) => pattern.test(value)));
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

export interface TransactionEvidence {
  source: string;
  value: string;
  strength: 'strong' | 'medium' | 'weak';
}

const DENIED_KEY = /(?:token|secret|password|credential|authorization|api[_-]?key|session)/i;
const MAX_DEPTH = 5;
const MAX_LENGTH = 2_000;

export function collectTransactionEvidence(
  listPayload: Record<string, unknown>,
  detailPayload: Record<string, unknown> | null = null
): TransactionEvidence[] {
  const evidence: TransactionEvidence[] = [];
  collectKnown(evidence, 'list', listPayload);
  if (detailPayload) collectKnown(evidence, 'detail', detailPayload);
  collectRaw(evidence, 'list', listPayload, 0, new Set());
  if (detailPayload) collectRaw(evidence, 'detail', detailPayload, 0, new Set());
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${item.source}\u0000${item.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectKnown(out: TransactionEvidence[], prefix: string, payload: Record<string, unknown>): void {
  for (const path of ['creditor.name', 'debtor.name', 'merchant_name', 'merchant.name', 'card_acceptor_name']) {
    const value = pathValue(payload, path);
    add(out, `${prefix}.${path}`, value, 'strong');
  }
  for (const path of [
    'remittance_information', 'note', 'reference_number',
    'creditor_account_additional_identification', 'debtor_account_additional_identification',
    'bank_transaction_code.description'
  ]) {
    const value = pathValue(payload, path);
    if (Array.isArray(value)) value.forEach((entry) => add(out, `${prefix}.${path}`, entry, 'medium'));
    else add(out, `${prefix}.${path}`, value, 'medium');
  }
}

function collectRaw(
  out: TransactionEvidence[], prefix: string, value: unknown, depth: number, ancestors: Set<unknown>, path = ''
): void {
  if (depth > MAX_DEPTH || ancestors.has(value)) return;
  if (typeof value === 'string') {
    // The diagnostic records that this came from the bounded proprietary-field
    // scan, without turning a bank-specific field path into user-facing data.
    add(out, `${prefix}.raw_alias_scan`, value, 'weak');
    return;
  }
  if (!value || typeof value !== 'object') return;
  ancestors.add(value);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (DENIED_KEY.test(key)) continue;
    collectRaw(out, prefix, child, depth + 1, ancestors, path ? `${path}.${key}` : key);
  }
  ancestors.delete(value);
}

function pathValue(payload: Record<string, unknown>, path: string): unknown {
  let value: unknown = payload;
  for (const part of path.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function add(out: TransactionEvidence[], source: string, value: unknown, strength: TransactionEvidence['strength']): void {
  if (typeof value !== 'string') return;
  const text = value.trim().slice(0, MAX_LENGTH);
  if (text) out.push({ source, value: text, strength });
}

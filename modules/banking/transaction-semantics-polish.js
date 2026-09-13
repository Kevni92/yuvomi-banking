const STYLE_ID = 'banking-transaction-semantics-polish';

/**
 * Replaces misleading processor/bank names with the operation the bank actually
 * reported when that operation is stronger evidence (for example Apple Pay card
 * payments or cash withdrawals). The raw provider payload remains available in
 * the detail dialog.
 */
export function installTransactionSemanticsPolish(
  container,
  context = {},
  getTransactions = () => [],
  getTransactionDetails = () => new Map()
) {
  ensureStyles();
  const runtime = {
    container,
    signal: context?.signal,
    getTransactions,
    getTransactionDetails,
    scheduled: false
  };
  apply(runtime);
  const observer = new MutationObserver((records) => {
    if (!records.some((record) => relevantMutation(record))) return;
    schedule(runtime);
  });
  observer.observe(container, { childList: true, subtree: true });
  runtime.signal?.addEventListener('abort', () => observer.disconnect(), { once: true });
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const link = document.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.href = new URL('./transaction-semantics-polish.css', import.meta.url).href;
  document.head.appendChild(link);
}

function relevantMutation(record) {
  const target = record.target instanceof Element ? record.target : record.target?.parentElement;
  if (!target) return true;
  if (target.closest('[data-transaction-semantics-owned], .banking-transaction-semantic-summary')) return false;
  return true;
}

function schedule(runtime) {
  if (runtime.scheduled || runtime.signal?.aborted) return;
  runtime.scheduled = true;
  requestAnimationFrame(() => {
    runtime.scheduled = false;
    if (!runtime.signal?.aborted) apply(runtime);
  });
}

function apply(runtime) {
  const transactions = Array.isArray(runtime.getTransactions?.()) ? runtime.getTransactions() : [];
  const byId = new Map(transactions.map((transaction) => [String(transaction?.id ?? ''), transaction]));
  decorateRows(runtime.container, byId);
  decorateDetail(runtime.container, runtime.getTransactionDetails?.());
}

function decorateRows(container, byId) {
  container.querySelectorAll('tr[data-transaction-row][data-transaction-id]').forEach((row) => {
    const transaction = byId.get(String(row.dataset.transactionId || ''));
    if (!transaction) return;
    const configuredTitle = text(transaction?.transaction_display_title);
    const semanticFallback = isPreferredSemantic(transaction) ? semanticDisplayLabel(transaction) : null;
    const display = configuredTitle || semanticFallback;
    if (!display) return;

    const merchant = row.querySelector('.banking-transactions-table__merchant');
    const title = merchant?.querySelector('.banking-merchant > span');
    if (!merchant || !title) return;

    const signature = JSON.stringify([
      display,
      transaction?.transaction_type_description,
      transaction?.purpose
    ]);
    if (merchant.dataset.transactionSemanticsSignature === signature) return;
    merchant.dataset.transactionSemanticsOwned = 'true';
    merchant.dataset.transactionSemanticsSignature = signature;
    title.textContent = display;

    const mark = merchant.querySelector('.banking-merchant-mark--fallback');
    if (mark) mark.textContent = initials(display);

    const secondary = meaningfulSecondaryLines(transaction, display);
    merchant.querySelectorAll(':scope > small').forEach((node) => node.remove());
    if (secondary.length) {
      const small = document.createElement('small');
      small.className = 'banking-transaction-semantic-context';
      small.textContent = secondary.join(' · ');
      merchant.append(small);
    }
  });
}

function decorateDetail(container, detailMap) {
  const dialog = container.querySelector('[data-banking-transaction-dialog]');
  const host = dialog?.querySelector('[data-banking-transaction-dialog-content]');
  if (!dialog?.open || !host) return;
  const enrich = host.querySelector('[data-action="enrich-transaction"]');
  const transactionId = String(enrich?.dataset.transactionId || '');
  const detail = detailMap instanceof Map ? detailMap.get(transactionId) : null;
  if (!detail?.transaction) return;

  const semantics = deriveFromStableCode(detail.transaction.bank_transaction_code);
  if (!semantics.kind || semantics.kind === 'other') return;
  const signature = JSON.stringify(semantics);
  let summary = host.querySelector('.banking-transaction-semantic-summary');
  if (summary?.dataset.signature === signature) return;
  summary?.remove();

  summary = document.createElement('section');
  summary.className = 'banking-transaction-semantic-summary';
  summary.dataset.transactionSemanticsOwned = 'true';
  summary.dataset.signature = signature;
  const items = [
    ['Umsatzart', semantics.label],
    ['Zahlungsweg', semantics.paymentMethod],
    ['Bank-Klassifizierung', semantics.description]
  ].filter(([, value]) => value);
  summary.innerHTML = `<h3>Erkannte Umsatzdaten</h3><dl>${items.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`;

  const mainSummary = host.querySelector('.banking-transaction-detail-summary');
  mainSummary?.after(summary);
  if (semantics.preferDisplay && shouldPreferSemanticDetail(detail.transaction)) {
    const title = mainSummary?.querySelector('div > strong');
    if (title) title.textContent = semantics.paymentMethod || semantics.displayLabel || semantics.label || title.textContent;
  }
}

function isPreferredSemantic(transaction) {
  return transaction?.prefer_transaction_type_display === true
    || Number(transaction?.prefer_transaction_type_display) === 1;
}

function semanticDisplayLabel(transaction) {
  const method = text(transaction?.payment_method);
  if (transaction?.transaction_type === 'card_payment' && method) return method;
  if (typeof transaction?.transaction_display_label === 'string' && transaction.transaction_display_label.trim()) {
    return transaction.transaction_display_label.trim();
  }
  const label = text(transaction?.transaction_type_label);
  return label && method ? `${label} · ${method}` : method || label;
}

function meaningfulSecondaryLines(transaction, display) {
  const values = [];
  const description = cleanSecondaryText(transaction?.transaction_type_description);
  const purpose = cleanSecondaryText(transaction?.purpose);
  const displayNormalized = normalize(display);
  if (description) {
    const descriptionNormalized = normalize(description);
    if (
      descriptionNormalized !== displayNormalized
      && !displayNormalized.includes(descriptionNormalized)
      && !descriptionNormalized.includes(displayNormalized)
    ) {
      values.push(description);
    }
  }
  if (purpose) {
    const purposeNormalized = normalize(purpose);
    if (
      purposeNormalized !== displayNormalized
      && !values.some((item) => normalize(item) === purposeNormalized)
    ) {
      values.push(purpose);
    }
  }
  return values;
}

function cleanSecondaryText(value) {
  const raw = text(value);
  if (!raw) return null;
  // Some ASPSPs/N26 expose the ISO-style family marker "PMNT" as a human
  // description. It only means "payment" and adds no value in the UI. Strip it
  // when it prefixes real remittance text and hide it when it is the whole value.
  const stripped = raw
    .replace(/^(?:PMNT|PAYMENT)\b\s*(?:[·•|:;\/-]\s*)*/i, '')
    .trim();
  if (!stripped || isGenericSecondaryText(stripped)) return null;
  return stripped;
}

function isGenericSecondaryText(value) {
  const normalized = normalize(value);
  return [
    'PMNT',
    'PAYMENT',
    'ZAHLUNG',
    'CARD PAYMENT',
    'KARTENZAHLUNG',
    'POS',
    'POSD',
    'CCRD'
  ].includes(normalized);
}

function shouldPreferSemanticDetail(transaction) {
  const merchant = text(transaction?.merchant_name);
  const counterparty = text(transaction?.counterparty_name);
  return !merchant || looksTechnicalParty(merchant) || looksTechnicalParty(counterparty);
}

function looksTechnicalParty(value) {
  if (!value) return false;
  const normalized = normalize(value);
  return /\b(LANDESBANK|SPARKASSE|SPK|BANK|ISSUER|PAYMENT SERVICES?|CARD SERVICES?)\b/.test(normalized)
    || /\bGA\s+NR\d+/i.test(value)
    || /\bBLZ\d+/i.test(value)
    || /^MO\s+\d{6,}(?:\s+|$)/i.test(value)
    || /^[A-Z]{1,3}\s+\d{6,}\s+\d{8,}[A-Z0-9]*$/i.test(value);
}

function deriveFromStableCode(value) {
  let record = value;
  if (typeof record === 'string') {
    try { record = JSON.parse(record); } catch { record = { description: record }; }
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return emptySemantic();
  const description = text(record.description);
  const code = text(record.code);
  const evidence = normalize([description, code, text(record.sub_code ?? record.subCode)].filter(Boolean).join(' '));
  const paymentMethod = evidence.includes('APPLE PAY') ? 'Apple Pay'
    : evidence.includes('GOOGLE PAY') ? 'Google Pay' : null;

  if (contains(evidence, ['BARGELDAUSZAHLUNG', 'BARGELD AUSZAHLUNG', 'CASH WITHDRAWAL', 'ATM WITHDRAWAL', 'GELDAUTOMAT'])) {
    return semantic('cash_withdrawal', 'Bargeldabhebung', description, null, true);
  }
  if (contains(evidence, ['BARGELDEINZAHLUNG', 'BARGELD EINZAHLUNG', 'CASH DEPOSIT', 'ATM DEPOSIT'])) {
    return semantic('cash_deposit', 'Bargeldeinzahlung', description, null, true);
  }
  if (contains(evidence, ['DAUERAUFTRAG', 'STANDING ORDER'])) {
    return semantic('standing_order', 'Dauerauftrag', description, null, false);
  }
  if (contains(evidence, ['LASTSCHRIFT', 'DIRECT DEBIT', 'SEPA DD'])) {
    return semantic('direct_debit', 'Lastschrift', description, null, false);
  }
  if (paymentMethod || contains(evidence, ['E COM', 'ECOM', 'KARTENZAHLUNG', 'CARD PAYMENT', 'DEBITKARTE', 'CREDIT CARD', 'MASTERCARD', 'VISA'])) {
    return semantic('card_payment', 'Kartenzahlung', description, paymentMethod, true);
  }
  if (contains(evidence, ['UBERWEISUNG', 'UEBERWEISUNG', 'CREDIT TRANSFER', 'SEPA TRANSFER', 'BANK TRANSFER'])) {
    return semantic('transfer', 'Überweisung', description, null, false);
  }
  return { ...emptySemantic(), kind: description || code ? 'other' : null, description, paymentMethod };
}

function semantic(kind, label, description, paymentMethod, preferDisplay) {
  return {
    kind,
    label,
    description,
    paymentMethod,
    displayLabel: paymentMethod ? `${label} · ${paymentMethod}` : label,
    preferDisplay
  };
}

function emptySemantic() {
  return { kind: null, label: null, description: null, paymentMethod: null, displayLabel: null, preferDisplay: false };
}

function contains(value, needles) {
  return needles.some((needle) => value.includes(normalize(needle)));
}

function normalize(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function initials(value) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length === 1 ? words[0].slice(0, 2) : `${words[0][0]}${words[1][0]}`).toUpperCase();
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const STYLE_ID = 'banking-transaction-sync-polish';

/**
 * Presentation layer for metadata returned by GET /transactions.
 *
 * The base transaction renderer deliberately stays generic. This layer adds
 * two banking-specific cues without creating synthetic database rows:
 * - a reliable provider-derived time underneath the booking date;
 * - a separator between transactions first discovered by the latest account
 *   fetch and older transactions.
 */
export function installTransactionSyncPolish(container, context = {}, getTransactions = () => []) {
  const host = container.querySelector('[data-banking-transactions-table]');
  if (!host) return;
  ensureStyles();

  const runtime = {
    container,
    host,
    signal: context?.signal,
    getTransactions,
    scheduled: false
  };

  applyTransactionSyncPolish(runtime);
  const observer = new MutationObserver((records) => {
    if (!records.some((record) => isRelevantMutation(record))) return;
    scheduleTransactionSyncPolish(runtime);
  });
  observer.observe(host, { childList: true, subtree: true });
  runtime.signal?.addEventListener('abort', () => observer.disconnect(), { once: true });
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const link = document.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.href = new URL('./transaction-sync-polish.css', import.meta.url).href;
  document.head.appendChild(link);
}

function isRelevantMutation(record) {
  const target = record.target instanceof Element ? record.target : record.target?.parentElement;
  if (!target) return true;
  if (target.matches('[data-transaction-sync-date-owned]')) return false;
  if (target.closest('.banking-recent-sync-separator')) return false;
  return true;
}

function scheduleTransactionSyncPolish(runtime) {
  if (runtime.scheduled || runtime.signal?.aborted) return;
  runtime.scheduled = true;
  requestAnimationFrame(() => {
    runtime.scheduled = false;
    if (!runtime.signal?.aborted) applyTransactionSyncPolish(runtime);
  });
}

function applyTransactionSyncPolish(runtime) {
  const table = runtime.host.querySelector('.banking-transactions-table');
  if (!table) return;
  const transactions = Array.isArray(runtime.getTransactions?.()) ? runtime.getTransactions() : [];
  const byId = new Map(transactions.map((transaction) => [String(transaction?.id ?? ''), transaction]));
  decorateTransactionTimes(table, byId);
  renderLatestSyncBoundary(table, byId);
}

function decorateTransactionTimes(table, byId) {
  table.querySelectorAll('tr[data-transaction-row][data-transaction-id]').forEach((row) => {
    const transaction = byId.get(String(row.dataset.transactionId || ''));
    const cell = row.querySelector('.banking-transactions-table__date');
    if (!cell) return;
    const time = normalizedTime(transaction?.transaction_time);
    const signature = time || '-';
    if (cell.dataset.transactionTimeSignature === signature) return;

    const existingDate = cell.querySelector('.banking-transactions-table__date-main')?.textContent
      || cell.textContent
      || '–';
    cell.dataset.transactionTimeSignature = signature;
    cell.dataset.transactionSyncDateOwned = 'true';
    cell.replaceChildren();

    const stack = document.createElement('span');
    stack.className = 'banking-transactions-table__date-stack';
    const date = document.createElement('span');
    date.className = 'banking-transactions-table__date-main';
    date.textContent = existingDate.trim() || '–';
    stack.append(date);
    if (time) {
      const clock = document.createElement('span');
      clock.className = 'banking-transactions-table__date-time';
      clock.textContent = time;
      stack.append(clock);
    }
    cell.append(stack);
  });
}

function renderLatestSyncBoundary(table, byId) {
  const tbody = table.tBodies?.[0];
  if (!tbody) return;
  const transactionRows = [...tbody.querySelectorAll('tr[data-transaction-row][data-transaction-id]')];
  const newRows = transactionRows.filter((row) => isNewTransaction(byId.get(String(row.dataset.transactionId || ''))));

  for (const row of transactionRows) {
    if (isNewTransaction(byId.get(String(row.dataset.transactionId || '')))) {
      row.dataset.newSinceLastSync = 'true';
    } else {
      delete row.dataset.newSinceLastSync;
    }
  }

  const existing = tbody.querySelector(':scope > .banking-recent-sync-separator');
  if (!newRows.length) {
    existing?.remove();
    return;
  }

  const signature = newRows.map((row) => row.dataset.transactionId).join(',');
  if (existing?.dataset.signature === signature) return;
  existing?.remove();

  const separator = document.createElement('tr');
  separator.className = 'banking-recent-sync-separator';
  separator.dataset.signature = signature;
  separator.setAttribute('aria-label', `${newRows.length} neue Umsätze seit dem letzten Abruf`);
  const cell = document.createElement('td');
  cell.colSpan = Math.max(1, table.querySelectorAll('thead th:not([hidden])').length);
  const content = document.createElement('div');
  content.className = 'banking-recent-sync-separator__content';
  const label = document.createElement('span');
  label.textContent = `${newRows.length} ${newRows.length === 1 ? 'neuer Umsatz' : 'neue Umsätze'} seit letztem Abruf`;
  content.append(label);
  cell.append(content);
  separator.append(cell);

  // In the default date-descending view newly imported rows form the leading
  // block. Put the marker at the boundary, like the budget-week separator. If
  // another sort order interleaves rows, fall back to placing it before the
  // first new row rather than pretending there is a contiguous range.
  let leadingNew = 0;
  while (leadingNew < transactionRows.length && newRows.includes(transactionRows[leadingNew])) leadingNew += 1;

  if (leadingNew > 0) {
    const firstOld = transactionRows[leadingNew] || null;
    if (!firstOld) {
      tbody.append(separator);
      return;
    }
    const previous = firstOld.previousElementSibling;
    const anchor = previous?.classList.contains('banking-budget-week-separator') ? previous : firstOld;
    tbody.insertBefore(separator, anchor);
    return;
  }

  const firstNew = newRows[0];
  tbody.insertBefore(separator, firstNew);
}

function normalizedTime(value) {
  if (typeof value !== 'string') return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return match ? `${match[1]}:${match[2]}` : null;
}

function isNewTransaction(transaction) {
  return transaction?.new_since_last_sync === true || Number(transaction?.new_since_last_sync) === 1;
}

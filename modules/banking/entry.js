import { render as renderEnhanced } from './enhanced-index.js';
import { installMainLayoutPolish } from './layout-polish.js';
import { installTransactionSyncPolish } from './transaction-sync-polish.js';
import { installTransactionSemanticsPolish } from './transaction-semantics-polish.js';

const TABLE_LAYOUT_STYLE_ID = 'banking-table-layout-compat';

// The enhancement layer deliberately post-processes markup produced by the stable
// base module. Suppress MutationObserver records caused by that post-processing
// itself, while still observing base-module re-renders (filters/table/categories).
export async function render(container, context) {
  const NativeMutationObserver = window.MutationObserver;
  const nativeFetch = window.fetch.bind(window);
  let latestTransactions = [];
  const latestTransactionDetails = new Map();

  class BankingMutationObserver extends NativeMutationObserver {
    constructor(callback) {
      super((records, observer) => {
        const filtered = records.filter((record) => !isEnhancementMutation(record));
        if (filtered.length) callback(filtered, observer);
      });
    }
  }

  // Account aliases/colors are updated through a small preferences endpoint.
  // After a successful write, ask the existing transaction filter controller to
  // reload its list so cached row metadata immediately reflects the new alias/color.
  // The same wrapper keeps the latest public transaction payload and transaction
  // detail payloads available for presentation-only enhancement layers.
  const preferenceAwareFetch = async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl, window.location.origin);
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const response = await nativeFetch(input, init);

    if (response.ok && method === 'GET' && url.pathname === '/api/extensions/banking/transactions') {
      try {
        const payload = await response.clone().json();
        latestTransactions = Array.isArray(payload?.data?.transactions) ? payload.data.transactions : [];
      } catch {
        latestTransactions = [];
      }
    }

    const transactionDetailMatch = method === 'GET'
      ? /^\/api\/extensions\/banking\/transactions\/(\d+)$/.exec(url.pathname)
      : null;
    if (response.ok && transactionDetailMatch) {
      try {
        const payload = await response.clone().json();
        if (payload?.data) latestTransactionDetails.set(transactionDetailMatch[1], payload.data);
      } catch {
        latestTransactionDetails.delete(transactionDetailMatch[1]);
      }
    }

    if (
      response.ok
      && method === 'PATCH'
      && /^\/api\/extensions\/banking\/accounts\/\d+\/preferences$/.test(url.pathname)
    ) {
      queueMicrotask(() => {
        const accountFilter = container.querySelector('[data-transaction-filter="accountId"]');
        accountFilter?.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    return response;
  };

  window.MutationObserver = BankingMutationObserver;
  window.fetch = preferenceAwareFetch;
  context?.signal?.addEventListener('abort', () => {
    // enhanced-index restores its inner fetch wrapper during the same abort
    // dispatch. Restore the pre-Banking fetch one microtask later.
    queueMicrotask(() => { window.fetch = nativeFetch; });
  }, { once: true });

  let result;
  try {
    result = await renderEnhanced(container, context);
  } finally {
    window.MutationObserver = NativeMutationObserver;
    // Do not restore fetch here: enhanced-index intentionally keeps its scoped
    // wrapper until the page signal aborts.
  }

  if (!context?.signal?.aborted) {
    await installMainLayoutPolish(container, context);
    installTransactionSyncPolish(container, context, () => latestTransactions);
    installTransactionSemanticsPolish(
      container,
      context,
      () => latestTransactions,
      () => latestTransactionDetails
    );
    ensureTableLayoutCompatStyles();
  }
  return result;
}

function ensureTableLayoutCompatStyles() {
  if (document.getElementById(TABLE_LAYOUT_STYLE_ID)) return;
  const link = document.createElement('link');
  link.id = TABLE_LAYOUT_STYLE_ID;
  link.rel = 'stylesheet';
  link.href = new URL('./table-layout-compat.css', import.meta.url).href;
  document.head.appendChild(link);
}

function isEnhancementMutation(record) {
  if (record.type !== 'childList' && record.type !== 'attributes') return false;
  const target = record.target instanceof Element ? record.target : record.target?.parentElement;
  if (!target) return false;
  if (target.matches('[data-transaction-sync-date-owned], [data-transaction-semantics-owned]')) return true;
  if ([...record.addedNodes].some((node) => node instanceof Element && (
    node.matches('.banking-recent-sync-separator')
    || node.matches('.banking-transaction-semantic-summary')
  ))) return true;
  return Boolean(target.closest(
    '[data-enhanced-category-chip],'
    + '[data-enhanced-signature],'
    + '[data-category-filter-trigger],'
    + '[data-category-icon-grid],'
    + '[data-category-preview],'
    + '[data-action="toggle-category-icons"],'
    + '.banking-category-dialog__visuals,'
    + '.banking-account-card__identity--enhanced,'
    + '.banking-transactions-table__date-stack,'
    + '.banking-recent-sync-separator,'
    + '[data-transaction-semantics-owned],'
    + '.banking-transaction-semantic-summary,'
    + 'select[data-transaction-filter="accountId"]'
  ));
}

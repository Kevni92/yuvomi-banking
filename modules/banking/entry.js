import { render as renderEnhanced } from './enhanced-index.js';

// The enhancement layer deliberately post-processes markup produced by the stable
// base module. Suppress MutationObserver records caused by that post-processing
// itself, while still observing base-module re-renders (filters/table/categories).
export async function render(container, context) {
  const NativeMutationObserver = window.MutationObserver;
  class BankingMutationObserver extends NativeMutationObserver {
    constructor(callback) {
      super((records, observer) => {
        const filtered = records.filter((record) => !isEnhancementMutation(record));
        if (filtered.length) callback(filtered, observer);
      });
    }
  }
  window.MutationObserver = BankingMutationObserver;
  try {
    return await renderEnhanced(container, context);
  } finally {
    window.MutationObserver = NativeMutationObserver;
  }
}

function isEnhancementMutation(record) {
  if (record.type !== 'childList' && record.type !== 'attributes') return false;
  const target = record.target instanceof Element ? record.target : record.target?.parentElement;
  if (!target) return false;
  return Boolean(target.closest(
    '[data-enhanced-category-chip],'
    + '[data-enhanced-signature],'
    + '[data-category-filter-trigger],'
    + '[data-category-icon-grid],'
    + '[data-category-preview],'
    + '.banking-category-dialog__visuals,'
    + '.banking-account-card__identity--enhanced,'
    + 'select[data-transaction-filter="accountId"]'
  ));
}

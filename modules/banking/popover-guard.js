const POPOVER_SELECTOR = [
  '.banking-transaction-context-menu',
  '.banking-category-picker-menu',
  '.banking-transaction-filter-multiselect__menu',
  '.banking-account-color-popover'
].join(', ');

const TRIGGER_TO_POPOVER = [
  ['[data-action="transaction-menu"]', '.banking-transaction-context-menu'],
  ['[data-enhanced-category-chip]', '.banking-category-picker-menu'],
  ['[data-category-filter-trigger]', '.banking-transaction-filter-multiselect__menu'],
  ['[data-account-color-edit]', '.banking-account-color-popover']
];

/**
 * Popovers are rendered below document.body, while the Banking page itself has
 * several delegated event handlers. Core/UI handlers may stop bubbling before
 * the old document-level outside-click handler sees the event. Listen during
 * capture instead and make the rule explicit: at most one Banking popover may
 * stay open at a time.
 */
export function installPopoverGuard(container, context) {
  const signal = context?.signal;
  const captureOptions = signal ? { capture: true, signal } : { capture: true };
  const passiveOptions = signal ? { signal } : undefined;

  const closeAll = (except = null) => {
    for (const popover of document.querySelectorAll(POPOVER_SELECTOR)) {
      if (popover === except) continue;
      popover.hidden = true;
    }
    syncTransactionMenuAria(container);
  };

  document.addEventListener('pointerdown', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) {
      closeAll();
      return;
    }

    // Clicking a trigger must leave only that trigger's own popover alone until
    // its click handler runs. This preserves toggle behaviour for the category
    // filter while still closing every other open popover first.
    for (const [triggerSelector, popoverSelector] of TRIGGER_TO_POPOVER) {
      if (!target.closest(triggerSelector)) continue;
      closeAll(document.querySelector(popoverSelector));
      return;
    }

    const currentPopover = target.closest(POPOVER_SELECTOR);
    if (currentPopover) {
      closeAll(currentPopover);
      return;
    }

    closeAll();
  }, captureOptions);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeAll();
  }, captureOptions);

  // The floating menu owns the focus after it opens. A focus change does not
  // necessarily produce a pointer event (keyboard navigation, assistive
  // technology and programmatic focus all bypass pointerdown), so dismiss the
  // menu when focus really leaves it. Keep it open while focus moves between
  // controls inside the same menu, for example from the search field to an
  // option button.
  document.addEventListener('focusout', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const next = event.relatedTarget instanceof Element ? event.relatedTarget : null;
    for (const popover of document.querySelectorAll(POPOVER_SELECTOR)) {
      if (popover.hidden || !popover.contains(target)) continue;
      if (!next || !popover.contains(next)) popover.hidden = true;
    }
    syncTransactionMenuAria(container);
  }, captureOptions);

  // A detached floating menu should not survive a viewport/app focus change.
  window.addEventListener('blur', () => closeAll(), passiveOptions);
  window.addEventListener('resize', () => closeAll(), passiveOptions);
}

function syncTransactionMenuAria(container) {
  const transactionMenuOpen = Boolean(
    document.querySelector('.banking-transaction-context-menu:not([hidden])')
  );
  if (transactionMenuOpen) return;
  container.querySelectorAll('[data-action="transaction-menu"][aria-expanded="true"]')
    .forEach((button) => button.setAttribute('aria-expanded', 'false'));
}

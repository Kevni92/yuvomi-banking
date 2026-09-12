import { render as renderBase } from './index.js';
import {
  PHOSPHOR_ICONS,
  findPhosphorIcon,
  renderPhosphorIcon,
  searchPhosphorIcons
} from './vendor/phosphor-icons.js';

const API_PREFIX = '/api/extensions/banking';
const STYLE_ID = 'banking-visual-enhancements';
const DEFAULT_CATEGORY_COLOR = '#8B5CF6';
const DEFAULT_ACCOUNT_COLOR = '#737373';
const MIN_AUTO_COLOR_DISTANCE = 0.105;
const COLOR_PALETTE = [
  '#2563EB', '#7C3AED', '#DB2777', '#DC2626', '#EA580C', '#CA8A04',
  '#65A30D', '#16A34A', '#059669', '#0D9488', '#0891B2', '#0284C7',
  '#4F46E5', '#9333EA', '#C026D3', '#E11D48', '#B45309', '#4D7C0F',
  '#15803D', '#047857', '#0F766E', '#0E7490', '#0369A1', '#4338CA'
];

export async function render(container, context) {
  ensureEnhancementStyles();
  const runtime = createRuntime(container, context?.signal);
  const restoreFetch = installFetchEnhancements(runtime);
  context?.signal?.addEventListener('abort', restoreFetch, { once: true });

  await renderBase(container, context);
  if (context?.signal?.aborted) return;

  await loadAccountPreferences(runtime);
  wireEnhancementEvents(runtime);
  installEnhancementObserver(runtime);
  enhanceAll(runtime);
}

function createRuntime(container, signal) {
  return {
    container,
    signal,
    transactionCache: new Map(),
    accountPreferences: new Map(),
    transactionMenu: null,
    categoryPicker: null,
    filterCategoryMenu: null,
    accountColorPopover: null,
    scheduled: false
  };
}

function ensureEnhancementStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const link = document.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.href = new URL('./visual-enhancements.css', import.meta.url).href;
  document.head.appendChild(link);
}

function installFetchEnhancements(runtime) {
  const originalFetch = window.fetch.bind(window);
  const patchedFetch = async (input, init) => {
    let requestInput = input;
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl, window.location.origin);

    if (method === 'GET' && url.pathname === `${API_PREFIX}/transactions`) {
      const state = runtime.container.bankingTransactionState;
      if (state?.weeklyBudgetOnly) url.searchParams.set('weekly_budget', '1');
      requestInput = input instanceof Request
        ? new Request(url.toString(), input)
        : `${url.pathname}${url.search}`;
    }

    let requestInit = init;
    if ((method === 'POST' || method === 'PATCH') && /^\/api\/extensions\/banking\/categories(?:\/\d+)?$/.test(url.pathname)) {
      const dialog = runtime.container.querySelector('[data-banking-category-dialog]');
      const icon = dialog?.querySelector('[data-category-icon-value]')?.value || null;
      const color = dialog?.querySelector('[data-category-color]')?.value || null;
      const existingBody = typeof init?.body === 'string' ? safeJson(init.body) : null;
      if (existingBody && typeof existingBody === 'object' && !Array.isArray(existingBody)) {
        requestInit = {
          ...init,
          body: JSON.stringify({ ...existingBody, icon, color })
        };
      }
    }

    const response = await originalFetch(requestInput, requestInit);
    if (method === 'GET' && url.pathname === `${API_PREFIX}/transactions` && response.ok) {
      try {
        const payload = await response.clone().json();
        const transactions = Array.isArray(payload?.data?.transactions) ? payload.data.transactions : [];
        runtime.transactionCache.clear();
        for (const transaction of transactions) {
          runtime.transactionCache.set(String(transaction?.id ?? ''), transaction);
        }
        scheduleEnhance(runtime);
      } catch {
        // Keep the base response authoritative if a proxy ever returns non-JSON.
      }
    }
    return response;
  };
  window.fetch = patchedFetch;
  return () => {
    if (window.fetch === patchedFetch) window.fetch = originalFetch;
  };
}

async function loadAccountPreferences(runtime) {
  try {
    const response = await fetch(`${API_PREFIX}/account-preferences`, {
      credentials: 'same-origin', cache: 'no-store', signal: runtime.signal
    });
    if (!response.ok) return;
    const payload = await response.json();
    for (const item of Array.isArray(payload?.data) ? payload.data : []) {
      runtime.accountPreferences.set(String(item.id), {
        alias: typeof item.alias === 'string' ? item.alias : null,
        color: validHex(item.color) ? item.color.toUpperCase() : null
      });
    }
    mergePreferencesIntoAccounts(runtime);
  } catch {
    // Presentation preferences are optional; the provider names remain usable.
  }
}

function mergePreferencesIntoAccounts(runtime) {
  const accounts = runtime.container.bankingTransactionAccounts;
  if (!Array.isArray(accounts)) return;
  for (const account of accounts) {
    const pref = runtime.accountPreferences.get(String(account?.id ?? ''));
    if (!pref) continue;
    account.alias = pref.alias;
    account.color = pref.color;
  }
}

function installEnhancementObserver(runtime) {
  const observer = new MutationObserver(() => scheduleEnhance(runtime));
  observer.observe(runtime.container, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
  runtime.signal?.addEventListener('abort', () => observer.disconnect(), { once: true });
}

function scheduleEnhance(runtime) {
  if (runtime.scheduled || runtime.signal?.aborted) return;
  runtime.scheduled = true;
  requestAnimationFrame(() => {
    runtime.scheduled = false;
    if (!runtime.signal?.aborted) enhanceAll(runtime);
  });
}

function enhanceAll(runtime) {
  mergePreferencesIntoAccounts(runtime);
  enhanceAccounts(runtime);
  enhanceAccountFilter(runtime);
  enhanceTransactionFilters(runtime);
  enhanceTransactionTable(runtime);
  enhanceCategoryDialog(runtime);
  enhanceCategoryManagement(runtime);
}

function wireEnhancementEvents(runtime) {
  const { container, signal } = runtime;

  container.addEventListener('click', (event) => {
    const transactionMenuButton = event.target.closest('[data-action="transaction-menu"]');
    if (transactionMenuButton) {
      event.preventDefault();
      event.stopPropagation();
      openTransactionMenu(runtime, transactionMenuButton);
      return;
    }

    const categoryChip = event.target.closest('[data-enhanced-category-chip]');
    if (categoryChip) {
      event.preventDefault();
      event.stopPropagation();
      openTransactionCategoryPicker(runtime, categoryChip);
      return;
    }

    const filterTrigger = event.target.closest('[data-category-filter-trigger]');
    if (filterTrigger) {
      event.preventDefault();
      toggleFilterCategoryMenu(runtime, filterTrigger);
      return;
    }

    const aliasButton = event.target.closest('[data-account-alias-edit]');
    if (aliasButton) {
      event.preventDefault();
      beginAliasEdit(runtime, aliasButton);
      return;
    }

    const colorButton = event.target.closest('[data-account-color-edit]');
    if (colorButton) {
      event.preventDefault();
      event.stopPropagation();
      openAccountColorPopover(runtime, colorButton);
      return;
    }

    const autoCategoryColor = event.target.closest('[data-action="auto-category-color"]');
    if (autoCategoryColor) {
      event.preventDefault();
      chooseAutomaticCategoryColor(runtime);
      return;
    }

    const categoryIconTrigger = event.target.closest('[data-action="toggle-category-icons"]');
    if (categoryIconTrigger) {
      event.preventDefault();
      const picker = container.querySelector('[data-category-icon-picker]');
      if (picker) picker.hidden = !picker.hidden;
      return;
    }

    if (event.target.closest('[data-action="add-category"], [data-action="edit-category"]')) {
      queueMicrotask(() => populateCategoryDialog(runtime));
    }
  }, { signal, capture: true });

  container.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="reset-transaction-filters"]')) {
      const state = container.bankingTransactionState;
      if (state) state.weeklyBudgetOnly = false;
    }
  }, { signal, capture: true });

  container.addEventListener('input', (event) => {
    if (event.target.matches('[data-category-icon-search]')) {
      renderCategoryIconGrid(runtime, event.target.value);
      return;
    }
    if (event.target.matches('[data-category-color], [data-category-name]')) {
      updateCategoryDialogPreview(runtime);
    }
  }, { signal });

  document.addEventListener('pointerdown', (event) => {
    for (const menu of [runtime.transactionMenu, runtime.categoryPicker, runtime.filterCategoryMenu, runtime.accountColorPopover]) {
      if (menu && !menu.hidden && !menu.contains(event.target)) menu.hidden = true;
    }
  }, { signal });
}

function enhanceAccounts(runtime) {
  runtime.container.querySelectorAll('[data-banking-account-card][data-account-id]').forEach((card) => {
    const accountId = String(card.dataset.accountId || '');
    const account = findAccount(runtime, accountId);
    const pref = preferenceFor(runtime, accountId, account);
    const identity = card.querySelector('.banking-account-card__identity');
    if (!identity) return;

    const providerName = String(account?.display_name || identity.querySelector('.banking-account-card__name')?.childNodes?.[0]?.textContent || '').trim();
    const role = identity.querySelector('.banking-account-card__role')?.cloneNode(true);
    const meta = identity.querySelector('.banking-account-card__meta');
    const displayName = pref.alias || providerName || 'Bankkonto';

    if (identity.dataset.enhancedSignature === `${displayName}|${pref.color || ''}`) return;
    identity.dataset.enhancedSignature = `${displayName}|${pref.color || ''}`;
    identity.classList.add('banking-account-card__identity--enhanced');
    identity.replaceChildren();

    const color = document.createElement('button');
    color.type = 'button';
    color.className = 'banking-account-color-button';
    color.dataset.accountColorEdit = accountId;
    color.style.setProperty('--account-color', pref.color || DEFAULT_ACCOUNT_COLOR);
    color.title = 'Kontofarbe ändern';
    color.setAttribute('aria-label', `Farbe für ${displayName} ändern`);

    const stack = document.createElement('span');
    stack.className = 'banking-account-label-stack';
    const firstLine = document.createElement('span');
    firstLine.style.display = 'flex';
    firstLine.style.alignItems = 'center';
    firstLine.style.gap = '.45rem';
    firstLine.style.minWidth = '0';
    const alias = document.createElement('button');
    alias.type = 'button';
    alias.className = 'banking-account-alias-button';
    alias.dataset.accountAliasEdit = accountId;
    alias.textContent = displayName;
    alias.title = providerName ? `Providername: ${providerName} · anklicken zum Umbenennen` : 'Anklicken zum Umbenennen';
    firstLine.append(alias);
    if (role) firstLine.append(role);
    stack.append(firstLine);
    if (meta) stack.append(meta);
    identity.append(color, stack);
  });
}

function enhanceAccountFilter(runtime) {
  const select = runtime.container.querySelector('select[data-transaction-filter="accountId"]');
  if (!select) return;
  for (const option of select.options) {
    if (!option.value) continue;
    const account = findAccount(runtime, option.value);
    const pref = preferenceFor(runtime, option.value, account);
    option.textContent = pref.alias || account?.display_name || option.textContent;
  }
}

function enhanceTransactionFilters(runtime) {
  const panel = runtime.container.querySelector('[data-transaction-filter-panel]');
  if (!panel) return;

  const nativeCategory = panel.querySelector('select[data-transaction-filter="categoryId"]');
  if (nativeCategory && !panel.querySelector('[data-category-filter-control]')) {
    const wrapper = document.createElement('div');
    wrapper.className = 'banking-transaction-filter-multiselect';
    wrapper.dataset.categoryFilterControl = 'true';
    const hidden = document.createElement('input');
    hidden.type = 'hidden';
    hidden.dataset.transactionFilter = 'categoryId';
    hidden.value = runtime.container.bankingTransactionState?.categoryId || '';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'banking-transaction-filter-multiselect__trigger';
    trigger.dataset.categoryFilterTrigger = 'true';
    wrapper.append(hidden, trigger);
    nativeCategory.closest('label')?.replaceWith(wrapper);
    updateFilterCategoryTrigger(runtime, wrapper);
  } else {
    const hidden = panel.querySelector('[data-category-filter-control] input[data-transaction-filter="categoryId"]');
    if (hidden) hidden.value = runtime.container.bankingTransactionState?.categoryId || '';
    updateFilterCategoryTrigger(runtime, panel.querySelector('[data-category-filter-control]'));
  }

  if (!panel.querySelector('[data-transaction-filter="weeklyBudgetOnly"]')) {
    const secondary = panel.querySelector('.banking-transaction-filter-row--secondary');
    if (secondary) {
      const label = document.createElement('label');
      label.className = 'banking-field--checkbox';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.transactionFilter = 'weeklyBudgetOnly';
      input.checked = Boolean(runtime.container.bankingTransactionState?.weeklyBudgetOnly);
      const text = document.createElement('span');
      text.textContent = 'Nur Wochenbudget';
      label.append(input, text);
      const reset = secondary.querySelector('[data-action="reset-transaction-filters"]');
      secondary.insertBefore(label, reset || null);
    }
  }
}

function updateFilterCategoryTrigger(runtime, wrapper) {
  if (!wrapper) return;
  const trigger = wrapper.querySelector('[data-category-filter-trigger]');
  if (!trigger) return;
  const ids = csvIds(runtime.container.bankingTransactionState?.categoryId);
  trigger.replaceChildren();
  const label = document.createElement('span');
  label.textContent = ids.length ? `Kategorien (${ids.length})` : 'Alle Kategorien';
  const chevron = document.createElement('span');
  chevron.textContent = '⌄';
  trigger.append(label, chevron);
}

function toggleFilterCategoryMenu(runtime, trigger) {
  const menu = ensureFilterCategoryMenu(runtime);
  if (!menu.hidden) {
    menu.hidden = true;
    return;
  }
  renderFilterCategoryMenu(runtime, menu);
  positionPopover(menu, trigger);
  menu.hidden = false;
}

function ensureFilterCategoryMenu(runtime) {
  if (runtime.filterCategoryMenu?.isConnected) return runtime.filterCategoryMenu;
  const menu = document.createElement('div');
  menu.className = 'banking-popover-surface banking-transaction-filter-multiselect__menu';
  menu.hidden = true;
  document.body.appendChild(menu);
  runtime.signal?.addEventListener('abort', () => menu.remove(), { once: true });
  runtime.filterCategoryMenu = menu;
  return menu;
}

function renderFilterCategoryMenu(runtime, menu) {
  menu.replaceChildren();
  const selected = new Set(csvIds(runtime.container.bankingTransactionState?.categoryId));
  for (const category of activeCategories(runtime)) {
    const label = document.createElement('label');
    label.className = 'banking-filter-category-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selected.has(String(category.id));
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selected.add(String(category.id)); else selected.delete(String(category.id));
      const hidden = runtime.container.querySelector('[data-category-filter-control] input[data-transaction-filter="categoryId"]');
      if (!hidden) return;
      hidden.value = [...selected].join(',');
      hidden.dispatchEvent(new Event('change', { bubbles: true }));
      updateFilterCategoryTrigger(runtime, hidden.closest('[data-category-filter-control]'));
    }, { signal: runtime.signal });
    label.append(checkbox, createCategoryIconNode(category), document.createTextNode(category.name || 'Kategorie'));
    menu.append(label);
  }
}

function enhanceTransactionTable(runtime) {
  const table = runtime.container.querySelector('.banking-transactions-table');
  if (!table) return;

  table.querySelectorAll('[data-transaction-column="weeklyBudget"]').forEach((element) => element.remove());
  runtime.container.querySelectorAll('[data-transaction-column-toggle="weeklyBudget"]').forEach((input) => input.closest('label')?.remove());

  for (const row of table.querySelectorAll('[data-transaction-row][data-transaction-id]')) {
    const transactionId = String(row.dataset.transactionId || '');
    const transaction = runtime.transactionCache.get(transactionId);
    if (transaction) {
      row.dataset.weeklyBudgetSelected = transaction.weekly_budget_selected ? 'true' : 'false';
      row.dataset.weeklyBudgetOverride = transaction.weekly_budget_override || 'inherit';
      enhanceTransactionAccountCell(runtime, row, transaction);
      enhanceTransactionCategoryCell(runtime, row, transaction);
    } else {
      const oldWeekly = row.querySelector('[data-weekly-budget-override]');
      if (oldWeekly) row.dataset.weeklyBudgetOverride = oldWeekly.value || 'inherit';
    }
    row.querySelector('[data-transaction-column="weeklyBudget"]')?.remove();
    const action = row.querySelector('button[data-action="transaction-details"], button[data-action="transaction-menu"]');
    if (action) {
      action.dataset.action = 'transaction-menu';
      action.dataset.transactionId = transactionId;
      action.setAttribute('aria-haspopup', 'menu');
      action.setAttribute('aria-expanded', 'false');
      action.setAttribute('aria-label', 'Umsatzaktionen');
    }
  }
}

function enhanceTransactionAccountCell(runtime, row, transaction) {
  const cell = row.querySelector('.banking-transactions-table__account');
  if (!cell) return;
  const accountId = String(transaction.account_id ?? '');
  const account = findAccount(runtime, accountId);
  const pref = {
    alias: transaction.account_alias || preferenceFor(runtime, accountId, account).alias,
    color: transaction.account_color || preferenceFor(runtime, accountId, account).color
  };
  const iban = cell.querySelector('small')?.textContent || account?.iban_masked || '';
  const display = pref.alias || transaction.account_display_name || account?.display_name || 'Bankkonto';
  const signature = `${display}|${pref.color || ''}|${iban}`;
  if (cell.dataset.enhancedSignature === signature) return;
  cell.dataset.enhancedSignature = signature;
  cell.replaceChildren();
  const visual = document.createElement('div');
  visual.className = 'banking-account-visual';
  const dot = document.createElement('span');
  dot.className = 'banking-account-color-dot';
  dot.style.setProperty('--account-color', pref.color || DEFAULT_ACCOUNT_COLOR);
  const stack = document.createElement('span');
  stack.className = 'banking-account-label-stack';
  const name = document.createElement('span');
  name.className = 'banking-transactions-table__account-name';
  name.textContent = display;
  stack.append(name);
  if (iban) {
    const meta = document.createElement('small');
    meta.textContent = iban;
    stack.append(meta);
  }
  visual.append(dot, stack);
  cell.append(visual);
  cell.title = transaction.account_display_name || display;
}

function enhanceTransactionCategoryCell(runtime, row, transaction) {
  const cell = row.querySelector('.banking-transactions-table__category');
  const select = cell?.querySelector('select[data-transaction-category-id]');
  if (!cell || !select) return;
  select.classList.add('banking-category-native-select');
  let chip = cell.querySelector('[data-enhanced-category-chip]');
  if (!chip) {
    chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'banking-category-chip';
    chip.dataset.enhancedCategoryChip = 'true';
    chip.dataset.transactionId = String(transaction.id);
    cell.append(chip);
  }
  chip.disabled = select.disabled;
  renderCategoryChip(chip, categoryById(runtime, transaction.category_id), 'Kategorie …');
}

function openTransactionMenu(runtime, button) {
  const transactionId = String(button.dataset.transactionId || '');
  if (!transactionId) return;
  const transaction = runtime.transactionCache.get(transactionId);
  const selected = transaction
    ? Boolean(transaction.weekly_budget_selected)
    : button.closest('[data-transaction-row]')?.dataset.weeklyBudgetSelected === 'true';
  const menu = ensureTransactionMenu(runtime);
  menu.replaceChildren();

  const details = contextMenuButton('Details anzeigen…');
  details.addEventListener('click', () => {
    menu.hidden = true;
    triggerBaseTransactionDetails(runtime, transactionId);
  }, { signal: runtime.signal });

  const weekly = contextMenuButton('Im Wochenbudget berücksichtigen');
  weekly.setAttribute('role', 'menuitemcheckbox');
  weekly.setAttribute('aria-checked', selected ? 'true' : 'false');
  weekly.addEventListener('click', async () => {
    weekly.disabled = true;
    try {
      await toggleTransactionWeeklyBudget(runtime, transactionId, !selected);
      menu.hidden = true;
    } finally {
      weekly.disabled = false;
    }
  }, { signal: runtime.signal });
  menu.append(details, weekly);
  positionPopover(menu, button, { alignRight: true });
  menu.hidden = false;
  button.setAttribute('aria-expanded', 'true');
}

function ensureTransactionMenu(runtime) {
  if (runtime.transactionMenu?.isConnected) return runtime.transactionMenu;
  const menu = document.createElement('div');
  menu.className = 'banking-transaction-context-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  document.body.appendChild(menu);
  runtime.signal?.addEventListener('abort', () => menu.remove(), { once: true });
  runtime.transactionMenu = menu;
  return menu;
}

function contextMenuButton(text) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'banking-context-menu__item';
  button.setAttribute('role', 'menuitem');
  button.textContent = text;
  return button;
}

function triggerBaseTransactionDetails(runtime, transactionId) {
  const host = runtime.container.querySelector('[data-banking-transactions]');
  if (!host) return;
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.hidden = true;
  trigger.dataset.action = 'transaction-details';
  trigger.dataset.transactionId = transactionId;
  host.appendChild(trigger);
  trigger.click();
  trigger.remove();
}

async function toggleTransactionWeeklyBudget(runtime, transactionId, include) {
  const transaction = runtime.transactionCache.get(transactionId);
  const category = categoryById(runtime, transaction?.category_id);
  const categoryDefault = Boolean(category?.weekly_budget_default);
  const override = include
    ? (categoryDefault ? 'inherit' : 'include')
    : (categoryDefault ? 'exclude' : 'inherit');
  await mutateJson(runtime, `transactions/${encodeURIComponent(transactionId)}/weekly-budget`, {
    weekly_budget_override: override
  });
  if (transaction) {
    transaction.weekly_budget_override = override;
    transaction.weekly_budget_selected = include ? 1 : 0;
  }
  const row = runtime.container.querySelector(`[data-transaction-row][data-transaction-id="${cssEscape(transactionId)}"]`);
  if (row) {
    row.dataset.weeklyBudgetOverride = override;
    row.dataset.weeklyBudgetSelected = include ? 'true' : 'false';
  }
  runtime.container.querySelector('[data-action="reload-weekly-budget"]')?.click();
}

function openTransactionCategoryPicker(runtime, chip) {
  const transactionId = String(chip.dataset.transactionId || '');
  const menu = ensureCategoryPicker(runtime);
  menu.replaceChildren();
  const search = document.createElement('input');
  search.className = 'form-input';
  search.type = 'search';
  search.placeholder = 'Kategorie suchen…';
  const list = document.createElement('div');
  list.className = 'banking-category-picker-menu__list';
  const renderList = () => {
    const query = search.value.trim().toLowerCase();
    list.replaceChildren();
    for (const category of activeCategories(runtime).filter((item) => !query || String(item.name || '').toLowerCase().includes(query))) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'banking-category-picker-option';
      button.append(createCategoryIconNode(category), document.createTextNode(category.name || 'Kategorie'));
      button.addEventListener('click', () => {
        const native = runtime.container.querySelector(`select[data-transaction-category-id="${cssEscape(transactionId)}"]`);
        if (!native) return;
        native.value = String(category.id);
        native.dispatchEvent(new Event('change', { bubbles: true }));
        menu.hidden = true;
      }, { signal: runtime.signal });
      list.append(button);
    }
  };
  search.addEventListener('input', renderList, { signal: runtime.signal });
  menu.append(search, list);
  renderList();
  positionPopover(menu, chip);
  menu.hidden = false;
  search.focus();
}

function ensureCategoryPicker(runtime) {
  if (runtime.categoryPicker?.isConnected) return runtime.categoryPicker;
  const menu = document.createElement('div');
  menu.className = 'banking-category-picker-menu';
  menu.hidden = true;
  document.body.appendChild(menu);
  runtime.signal?.addEventListener('abort', () => menu.remove(), { once: true });
  runtime.categoryPicker = menu;
  return menu;
}

function enhanceCategoryDialog(runtime) {
  const dialog = runtime.container.querySelector('[data-banking-category-dialog]');
  const body = dialog?.querySelector('.banking-category-dialog__body');
  if (!dialog || !body) return;
  if (!body.querySelector('[data-category-visuals]')) {
    const visuals = document.createElement('div');
    visuals.className = 'banking-category-dialog__visuals';
    visuals.dataset.categoryVisuals = 'true';
    visuals.innerHTML = `
      <div class="banking-field banking-category-icon-control">
        <span>Icon</span>
        <input type="hidden" data-category-icon-value value="tag">
        <button class="btn btn--secondary banking-category-icon-trigger" type="button" data-action="toggle-category-icons"></button>
        <div class="banking-category-icon-picker" data-category-icon-picker hidden>
          <input class="form-input" type="search" data-category-icon-search placeholder="Icon suchen…" autocomplete="off">
          <div class="banking-category-icon-grid" data-category-icon-grid></div>
        </div>
      </div>
      <label class="banking-field"><span>Farbe</span><div class="banking-category-color-row"><input type="color" data-category-color value="${DEFAULT_CATEGORY_COLOR}"><button class="btn btn--secondary" type="button" data-action="auto-category-color">Automatisch wählen</button></div></label>
      <div class="banking-field"><span>Vorschau</span><div class="banking-category-preview" data-category-preview></div></div>
    `;
    const weekly = body.querySelector('[data-category-weekly-budget]')?.closest('label');
    body.insertBefore(visuals, weekly || null);
    renderCategoryIconGrid(runtime, '');
  }
  if (dialog.open) populateCategoryDialog(runtime);
}

function populateCategoryDialog(runtime) {
  const dialog = runtime.container.querySelector('[data-banking-category-dialog]');
  if (!dialog) return;
  const category = categoryById(runtime, dialog.dataset.categoryId);
  const iconInput = dialog.querySelector('[data-category-icon-value]');
  const colorInput = dialog.querySelector('[data-category-color]');
  if (!iconInput || !colorInput) return;
  iconInput.value = category?.icon || 'tag';
  colorInput.value = validHex(category?.color) ? category.color : chooseDistinctColor(categoryColors(runtime, category?.id)) || DEFAULT_CATEGORY_COLOR;
  dialog.querySelector('[data-category-icon-search]').value = '';
  dialog.querySelector('[data-category-icon-picker]').hidden = true;
  renderCategoryIconGrid(runtime, '');
  updateCategoryDialogPreview(runtime);
}

function renderCategoryIconGrid(runtime, query) {
  const dialog = runtime.container.querySelector('[data-banking-category-dialog]');
  const grid = dialog?.querySelector('[data-category-icon-grid]');
  const iconInput = dialog?.querySelector('[data-category-icon-value]');
  if (!grid || !iconInput) return;
  grid.replaceChildren();
  for (const iconItem of searchPhosphorIcons(query)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'banking-category-icon-option';
    button.dataset.selected = iconInput.value === iconItem.name ? 'true' : 'false';
    button.title = iconItem.label;
    button.setAttribute('aria-label', iconItem.label);
    button.insertAdjacentHTML('beforeend', renderPhosphorIcon(iconItem.name));
    button.addEventListener('click', () => {
      iconInput.value = iconItem.name;
      renderCategoryIconGrid(runtime, dialog.querySelector('[data-category-icon-search]')?.value || '');
      updateCategoryDialogPreview(runtime);
    }, { signal: runtime.signal });
    grid.append(button);
  }
  updateCategoryIconTrigger(runtime);
}

function updateCategoryIconTrigger(runtime) {
  const dialog = runtime.container.querySelector('[data-banking-category-dialog]');
  const trigger = dialog?.querySelector('[data-action="toggle-category-icons"]');
  const value = dialog?.querySelector('[data-category-icon-value]')?.value || 'tag';
  if (!trigger) return;
  const iconItem = findPhosphorIcon(value);
  trigger.replaceChildren();
  trigger.insertAdjacentHTML('beforeend', renderPhosphorIcon(iconItem.name));
  trigger.append(document.createTextNode(iconItem.label));
}

function updateCategoryDialogPreview(runtime) {
  const dialog = runtime.container.querySelector('[data-banking-category-dialog]');
  const preview = dialog?.querySelector('[data-category-preview]');
  const name = dialog?.querySelector('[data-category-name]')?.value?.trim() || 'Kategorie';
  const icon = dialog?.querySelector('[data-category-icon-value]')?.value || 'tag';
  const color = dialog?.querySelector('[data-category-color]')?.value || DEFAULT_CATEGORY_COLOR;
  if (!preview) return;
  preview.replaceChildren();
  const demo = document.createElement('span');
  demo.className = 'banking-category-chip';
  setCategoryColors(demo, color);
  const iconWrap = document.createElement('span');
  iconWrap.className = 'banking-category-chip__icon';
  iconWrap.insertAdjacentHTML('beforeend', renderPhosphorIcon(icon));
  const label = document.createElement('span');
  label.textContent = name;
  demo.append(iconWrap, label);
  preview.append(demo);
  updateCategoryIconTrigger(runtime);
}

function chooseAutomaticCategoryColor(runtime) {
  const dialog = runtime.container.querySelector('[data-banking-category-dialog]');
  const input = dialog?.querySelector('[data-category-color]');
  if (!input) return;
  const categoryId = dialog.dataset.categoryId;
  const candidate = chooseDistinctColor(categoryColors(runtime, categoryId));
  if (candidate) {
    input.value = candidate;
    updateCategoryDialogPreview(runtime);
  }
}

function enhanceCategoryManagement(runtime) {
  const rows = runtime.container.querySelectorAll('.banking-category-row');
  for (const row of rows) {
    const edit = row.querySelector('[data-action="edit-category"], [data-action="reactivate-category"]');
    const categoryId = edit?.dataset.categoryId;
    const category = categoryById(runtime, categoryId);
    const identity = row.querySelector('.banking-category-row__identity');
    const strong = identity?.querySelector('strong');
    if (!category || !identity || !strong || identity.classList.contains('banking-category-row__identity--enhanced')) continue;
    identity.classList.add('banking-category-row__identity--enhanced');
    const icon = createCategoryIconNode(category);
    strong.prepend(icon);
  }
}

async function beginAliasEdit(runtime, button) {
  const accountId = String(button.dataset.accountAliasEdit || '');
  if (!accountId || button.dataset.editing === 'true') return;
  const account = findAccount(runtime, accountId);
  const pref = preferenceFor(runtime, accountId, account);
  const input = document.createElement('input');
  input.className = 'form-input banking-account-alias-input';
  input.type = 'text';
  input.maxLength = 80;
  input.value = pref.alias || '';
  input.placeholder = account?.display_name || 'Kontoname';
  button.dataset.editing = 'true';
  button.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    if (save) {
      try {
        const result = await mutateJson(runtime, `accounts/${encodeURIComponent(accountId)}/preferences`, {
          alias: input.value.trim() || null
        });
        const current = runtime.accountPreferences.get(accountId) || {};
        runtime.accountPreferences.set(accountId, { ...current, alias: result?.alias ?? null });
        mergePreferencesIntoAccounts(runtime);
      } catch {
        // Re-render with the previous preference if validation/network failed.
      }
    }
    const identity = input.closest('.banking-account-card__identity');
    if (identity) delete identity.dataset.enhancedSignature;
    enhanceAccounts(runtime);
    enhanceAccountFilter(runtime);
    enhanceTransactionTable(runtime);
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); void finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); void finish(false); }
  }, { signal: runtime.signal });
  input.addEventListener('blur', () => void finish(true), { once: true, signal: runtime.signal });
}

function openAccountColorPopover(runtime, button) {
  const accountId = String(button.dataset.accountColorEdit || '');
  if (!accountId) return;
  const account = findAccount(runtime, accountId);
  const pref = preferenceFor(runtime, accountId, account);
  const popover = ensureAccountColorPopover(runtime);
  popover.replaceChildren();
  const row = document.createElement('div');
  row.className = 'banking-account-color-popover__row';
  const input = document.createElement('input');
  input.type = 'color';
  input.value = pref.color || chooseDistinctColor(accountColors(runtime, accountId)) || DEFAULT_ACCOUNT_COLOR;
  const auto = document.createElement('button');
  auto.type = 'button';
  auto.className = 'btn btn--secondary';
  auto.textContent = 'Automatisch';
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'btn btn--secondary';
  clear.textContent = 'Ohne Farbe';
  const save = async (color) => {
    const result = await mutateJson(runtime, `accounts/${encodeURIComponent(accountId)}/preferences`, { color });
    const current = runtime.accountPreferences.get(accountId) || {};
    runtime.accountPreferences.set(accountId, { ...current, color: result?.color ?? null });
    mergePreferencesIntoAccounts(runtime);
    popover.hidden = true;
    runtime.container.querySelectorAll(`[data-banking-account-card][data-account-id="${cssEscape(accountId)}"] .banking-account-card__identity`).forEach((el) => delete el.dataset.enhancedSignature);
    enhanceAll(runtime);
  };
  input.addEventListener('change', () => void save(input.value), { signal: runtime.signal });
  auto.addEventListener('click', () => {
    const color = chooseDistinctColor(accountColors(runtime, accountId));
    if (color) { input.value = color; void save(color); }
  }, { signal: runtime.signal });
  clear.addEventListener('click', () => void save(null), { signal: runtime.signal });
  row.append(input, auto, clear);
  popover.append(row);
  positionPopover(popover, button);
  popover.hidden = false;
}

function ensureAccountColorPopover(runtime) {
  if (runtime.accountColorPopover?.isConnected) return runtime.accountColorPopover;
  const popover = document.createElement('div');
  popover.className = 'banking-account-color-popover';
  popover.hidden = true;
  document.body.appendChild(popover);
  runtime.signal?.addEventListener('abort', () => popover.remove(), { once: true });
  runtime.accountColorPopover = popover;
  return popover;
}

async function mutateJson(runtime, path, body) {
  const csrfResponse = await fetch(`${API_PREFIX}/csrf`, {
    credentials: 'same-origin', cache: 'no-store', signal: runtime.signal
  });
  if (!csrfResponse.ok) throw new Error('CSRF token unavailable.');
  const csrf = await csrfResponse.json();
  const response = await fetch(`${API_PREFIX}/${path}`, {
    method: 'PATCH',
    credentials: 'same-origin',
    cache: 'no-store',
    signal: runtime.signal,
    headers: { 'content-type': 'application/json', 'x-banking-csrf': csrf?.csrf_token ?? '' },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || 'Banking request failed.');
  return payload?.data;
}

function preferenceFor(runtime, accountId, account) {
  const pref = runtime.accountPreferences.get(String(accountId)) || {};
  return {
    alias: pref.alias || account?.alias || null,
    color: pref.color || account?.color || account?.color_hex || null
  };
}

function findAccount(runtime, accountId) {
  return (Array.isArray(runtime.container.bankingTransactionAccounts) ? runtime.container.bankingTransactionAccounts : [])
    .find((account) => String(account?.id ?? '') === String(accountId));
}

function activeCategories(runtime) {
  return (Array.isArray(runtime.container.bankingTransactionCategories) ? runtime.container.bankingTransactionCategories : [])
    .filter((category) => category?.active !== false && /^\d+$/.test(String(category?.id ?? '')));
}

function categoryById(runtime, categoryId) {
  const id = String(categoryId ?? '');
  if (!id) return null;
  return (Array.isArray(runtime.container.bankingTransactionCategories) ? runtime.container.bankingTransactionCategories : [])
    .find((category) => String(category?.id ?? '') === id) || null;
}

function createCategoryIconNode(category) {
  const span = document.createElement('span');
  span.className = 'banking-category-chip__icon';
  const color = validHex(category?.color) ? category.color : DEFAULT_CATEGORY_COLOR;
  span.style.setProperty('--category-color', color);
  span.style.color = color;
  span.insertAdjacentHTML('beforeend', renderPhosphorIcon(category?.icon || 'tag'));
  return span;
}

function renderCategoryChip(button, category, emptyLabel) {
  button.replaceChildren();
  const color = validHex(category?.color) ? category.color : null;
  setCategoryColors(button, color);
  if (category) button.append(createCategoryIconNode(category));
  const label = document.createElement('span');
  label.className = 'banking-category-chip__label';
  label.textContent = category?.name || emptyLabel;
  const chevron = document.createElement('span');
  chevron.className = 'banking-category-chip__chevron';
  chevron.textContent = '⌄';
  button.append(label, chevron);
}

function setCategoryColors(element, color) {
  if (!validHex(color)) {
    element.style.removeProperty('--category-color');
    element.style.removeProperty('--category-bg');
    element.style.removeProperty('--category-border');
    return;
  }
  element.style.setProperty('--category-color', color);
  element.style.setProperty('--category-bg', `color-mix(in srgb, ${color} 11%, transparent)`);
  element.style.setProperty('--category-border', `color-mix(in srgb, ${color} 32%, var(--color-border, transparent))`);
}

function categoryColors(runtime, exceptId) {
  return activeCategories(runtime)
    .filter((category) => String(category.id) !== String(exceptId ?? ''))
    .map((category) => category.color)
    .filter(validHex);
}

function accountColors(runtime, exceptId) {
  return [...runtime.accountPreferences.entries()]
    .filter(([id]) => id !== String(exceptId ?? ''))
    .map(([, pref]) => pref.color)
    .filter(validHex);
}

function chooseDistinctColor(existingColors) {
  const existing = existingColors.filter(validHex).map(hexToOklab);
  if (!existing.length) return COLOR_PALETTE[0];
  const candidates = [...COLOR_PALETTE, ...generatedColorCandidates()];
  let best = null;
  let bestDistance = -1;
  for (const color of candidates) {
    if (existingColors.some((existingColor) => existingColor?.toUpperCase() === color.toUpperCase())) continue;
    const lab = hexToOklab(color);
    const minDistance = Math.min(...existing.map((used) => oklabDistance(lab, used)));
    if (minDistance > bestDistance) {
      best = color;
      bestDistance = minDistance;
    }
  }
  return bestDistance >= MIN_AUTO_COLOR_DISTANCE ? best : null;
}

function generatedColorCandidates() {
  const result = [];
  for (let hue = 0; hue < 360; hue += 24) {
    result.push(hslToHex(hue, 68, 48), hslToHex((hue + 12) % 360, 60, 58));
  }
  return result;
}

function hexToOklab(hex) {
  const [r8, g8, b8] = [hex.slice(1,3), hex.slice(3,5), hex.slice(5,7)].map((value) => parseInt(value, 16) / 255);
  const linear = (value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  const r = linear(r8), g = linear(g8), b = linear(b8);
  const l = 0.4122214708*r + 0.5363325363*g + 0.0514459929*b;
  const m = 0.2119034982*r + 0.6806995451*g + 0.1073969566*b;
  const s = 0.0883024619*r + 0.2817188376*g + 0.6299787005*b;
  const l3 = Math.cbrt(l), m3 = Math.cbrt(m), s3 = Math.cbrt(s);
  return [
    0.2104542553*l3 + 0.793617785*m3 - 0.0040720468*s3,
    1.9779984951*l3 - 2.428592205*m3 + 0.4505937099*s3,
    0.0259040371*l3 + 0.7827717662*m3 - 0.808675766*s3
  ];
}

function oklabDistance(a, b) {
  return Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2*l - 1))*s;
  const x = c * (1 - Math.abs((h/60)%2 - 1));
  const m = l - c/2;
  let rgb = h < 60 ? [c,x,0] : h < 120 ? [x,c,0] : h < 180 ? [0,c,x] : h < 240 ? [0,x,c] : h < 300 ? [x,0,c] : [c,0,x];
  return `#${rgb.map((value) => Math.round((value+m)*255).toString(16).padStart(2,'0')).join('').toUpperCase()}`;
}

function positionPopover(popover, anchor, { alignRight = false } = {}) {
  popover.hidden = false;
  popover.style.visibility = 'hidden';
  const rect = anchor.getBoundingClientRect();
  const box = popover.getBoundingClientRect();
  let left = alignRight ? rect.right - box.width : rect.left;
  left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8));
  let top = rect.bottom + 6;
  if (top + box.height > window.innerHeight - 8) top = Math.max(8, rect.top - box.height - 6);
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popover.style.visibility = '';
}

function csvIds(value) {
  return String(value || '').split(',').map((part) => part.trim()).filter((part) => /^\d+$/.test(part));
}

function validHex(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

function safeJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function cssEscape(value) {
  return globalThis.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

import {
  renderPageHeader,
  renderPageTitle,
  renderPageActions,
  renderPageBody,
  renderPageSection
} from '/utils/page-layout.js';
import { esc } from '/utils/html.js';
import { t } from '/i18n.js';
import { api } from '/api.js';

const API_PREFIX = '/api/extensions/banking';

function localized(key, fallback, variables = {}) {
  const value = t(`extensions.banking.${key}`);
  const message = typeof value === 'string' && value !== `extensions.banking.${key}` ? value : fallback;
  return message.replace(/\{(\w+)\}/g, (_match, name) => String(variables[name] ?? ''));
}

async function loadJson(path, { signal, method = 'GET', body, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  const init = {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers: requestHeaders
  };
  if (body !== undefined) {
    requestHeaders['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const response = await fetch(`${API_PREFIX}/${path}`, init);
  if (!response.ok) {
    const error = new Error(
      `${localized('errors.request', 'Banking request failed')} (HTTP ${response.status})`
    );
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export async function render(container, context) {
  const signal = context?.signal ?? new AbortController().signal;
  const requestedView = new URLSearchParams(window.location.search).get('view');
  const view = requestedView === 'settings' ? 'settings' : 'main';
  const canReturnToMain = view === 'settings';

  container.replaceChildren();
  container.insertAdjacentHTML(
    'beforeend',
    renderPageHeader({
      title: renderPageTitle(localized(canReturnToMain ? 'settingsTitle' : 'title', canReturnToMain ? 'Banking settings' : 'Banking')),
      actions: renderPageActions(canReturnToMain
        ? `<a class="btn btn--secondary" href="/m/banking">${esc(localized('backToBanking', 'Back to Banking'))}</a>`
        : `<a class="btn btn--secondary" href="/m/banking?view=settings">${esc(localized('settings', 'Settings'))}</a>`)
    }) +
      renderPageBody({
        content: renderPageSection({
          content: view === 'settings' ? renderSettingsMarkup() : renderMainMarkup()
        })
      })
  );

  const sessionResult = await Promise.allSettled([loadJson('me', { signal })]);
  if (signal.aborted) return;

  const session = sessionResult[0].status === 'fulfilled' ? sessionResult[0].value?.data : null;
  const permission = session?.banking_permission ?? 'none';
  container.dataset.bankingPermission = permission;
  if (!session) {
    const error = sessionResult[0].reason;
    const host = container.querySelector('[data-banking-main-content]') ?? container.querySelector('[data-banking-settings-content]');
    if (host) renderError(host, error);
    return;
  }

  if (view === 'settings') {
    configureSettingsInteractions(container, permission, signal);
    await loadSettingsView(container, signal, permission === 'write');
  } else {
    configureMainInteractions(container, permission, signal);
    await loadMainView(container, signal, permission === 'write');
  }
}

function renderMainMarkup() {
  return `
    <div data-banking-main-content>
      <section class="banking-panel" data-banking-weekly-budget>
        <div class="banking-panel__header">
          <div>
            <h2>${esc(localized('weeklyBudgetTitle', 'Weekly budget'))}</h2>
            <p class="banking-panel__description">${esc(localized('weeklyBudgetDescription', 'Sparkasse expenses and the current N26 balance determine the next refill.'))}</p>
          </div>
          <button class="btn btn--secondary" type="button" data-action="reload-weekly-budget">${esc(localized('reload', 'Reload'))}</button>
        </div>
        <div data-weekly-budget-current aria-live="polite"><p class="banking-muted">${esc(localized('loading', 'Loading ...'))}</p></div>
      </section>

      <details class="banking-panel banking-accounts-panel" data-banking-accounts-panel open>
        <summary>${esc(localized('accountsTitle', 'Accounts'))}</summary>
        <div class="banking-accounts-panel__body">
          <p class="banking-panel__description">${esc(localized('accountsDescription', 'Balances are loaded through the Banking sidecar.'))}</p>
          <div data-banking-accounts aria-live="polite"><p class="banking-muted">${esc(localized('loading', 'Loading ...'))}</p></div>
        </div>
      </details>

      ${renderTransactionsPanelMarkup()}

      <section class="banking-panel" data-banking-categorization>
        <div class="banking-panel__header">
          <div>
            <h2>${esc(localized('categorizationTitle', 'Transaction categorization'))}</h2>
            <p class="banking-panel__description">${esc(localized('categorizationDescription', 'Known recipients are handled locally first. Only unresolved transactions are sent as pseudonymized, reviewed suggestions.'))}</p>
          </div>
          <button class="btn btn--secondary" type="button" data-action="run-categorization">${esc(localized('categorizationRun', 'Analyze unresolved transactions'))}</button>
        </div>
        <p class="banking-feedback" data-categorization-feedback role="status"></p>
        <div data-categorization-reviews></div>
        <div data-categorization-suggestions></div>
      </section>

      <details class="banking-panel banking-weekly-history-panel" open>
        <summary>${esc(localized('weeklyBudgetHistory', 'Weekly-budget history'))}</summary>
        <div data-weekly-budget-history></div>
      </details>
    </div>
  `;
}

function renderSettingsMarkup() {
  const callbackState = new URLSearchParams(window.location.search).get('banking');
  const connectionsOpen = callbackState === 'error' || callbackState === 'connected';
  const callbackFeedback = callbackState === 'connected'
    ? `<p class="banking-feedback" role="status">${esc(localized('connectionCompleted', 'Bank connection completed.'))}</p>`
    : callbackState === 'error'
      ? `<p class="banking-error" role="alert">${esc(localized('connectionFailed', 'Bank connection could not be completed.'))}</p>`
      : '';
  return `
    <div data-banking-settings-content>
      <details class="banking-panel banking-settings-connections" data-banking-connections-panel${connectionsOpen ? ' open' : ''}>
        <summary>${esc(localized('connectionsTitle', 'Bank connections'))}</summary>
        <div class="banking-settings-connections__body">
          <p class="banking-panel__description">${esc(localized('connectionsDescription', 'Your connections are stored in the separate Banking database.'))}</p>
          ${callbackFeedback}
          <form class="banking-connect-form" data-banking-connect-form>
            <label class="banking-field"><span>${esc(localized('country', 'Country'))}</span><select class="form-input" data-banking-country><option value="DE">${esc(localized('germany', 'Germany'))}</option><option value="AT">${esc(localized('austria', 'Austria'))}</option><option value="CH">${esc(localized('switzerland', 'Switzerland'))}</option></select></label>
            <label class="banking-field"><span>${esc(localized('bank', 'Bank'))}</span><select class="form-input" data-banking-bank disabled><option value="">${esc(localized('loadBanksFirst', 'Load banks first'))}</option></select></label>
            <div class="banking-connect-form__actions"><button class="btn btn--secondary" type="button" data-action="load-banks">${esc(localized('loadBanks', 'Load banks'))}</button><button class="btn btn--primary" type="submit" data-action="connect-bank" disabled>${esc(localized('connectBank', 'Connect bank'))}</button></div>
          </form>
          <p class="banking-feedback" data-banking-connect-feedback role="status"></p>
          <div data-banking-connections aria-live="polite"><p class="banking-muted">${esc(localized('loading', 'Loading ...'))}</p></div>
        </div>
      </details>

      <section class="banking-panel" data-banking-weekly-budget>
        <div class="banking-panel__header"><div><h2>${esc(localized('weeklyBudgetConfigureTitle', 'Configure weekly budget'))}</h2><p class="banking-panel__description">${esc(localized('weeklyBudgetDescription', 'Sparkasse expenses and the current N26 balance determine the next refill.'))}</p></div></div>
        <div data-weekly-budget-current aria-live="polite"><p class="banking-muted">${esc(localized('loading', 'Loading ...'))}</p></div>
        ${weeklyBudgetSettingsMarkup()}
      </section>

      <section class="banking-panel banking-push" data-banking-push aria-live="polite">
        <div class="banking-panel__header"><div><h2>${esc(localized('pushTitle', 'Banking notifications'))}</h2><p class="banking-panel__description">${esc(localized('pushDescription', 'Enable notifications explicitly on this device.'))}</p></div><div class="banking-weekly-settings__actions"><button class="btn btn--secondary" type="button" data-action="enable-banking-push">${esc(localized('pushEnable', 'Enable on this device'))}</button><button class="btn btn--secondary" type="button" data-action="test-banking-push">${esc(localized('pushTest', 'Send test'))}</button></div></div>
        <p class="banking-feedback" data-banking-push-feedback role="status"></p><div data-banking-push-subscriptions></div>
      </section>

      <section class="banking-panel banking-weekly-categories"><h2>${esc(localized('weeklyBudgetCategories', 'Weekly-budget categories'))}</h2><p class="banking-panel__description">${esc(localized('weeklyBudgetCategoriesDescription', 'A transaction-specific setting overrides its category.'))}</p><div data-weekly-budget-categories></div></section>
    </div>
  `;
}

function weeklyBudgetSettingsMarkup() {
  return `
    <form class="banking-weekly-settings" data-weekly-budget-settings>
      <label class="banking-field banking-field--checkbox"><input type="checkbox" data-weekly-enabled><span>${esc(localized('weeklyBudgetEnabled', 'Enable weekly budget'))}</span></label>
      <label class="banking-field"><span>${esc(localized('weeklyBudgetSource', 'Source account'))}</span><select class="form-input" data-weekly-source required></select></label>
      <label class="banking-field"><span>${esc(localized('weeklyBudgetTarget', 'Target account'))}</span><select class="form-input" data-weekly-target required></select></label>
      <label class="banking-field"><span>${esc(localized('weeklyBudgetBeneficiary', 'Target account holder'))}</span><input class="form-input" maxlength="70" autocomplete="name" data-weekly-beneficiary required></label>
      <label class="banking-field"><span>${esc(localized('weeklyBudgetAmount', 'Weekly target in euros'))}</span><input class="form-input" inputmode="decimal" placeholder="450,00" data-weekly-amount required></label>
      <label class="banking-field"><span>${esc(localized('weeklyBudgetWeekday', 'Cutoff weekday'))}</span><select class="form-input" data-weekly-weekday required>${weekdayOptions()}</select></label>
      <label class="banking-field"><span>${esc(localized('weeklyBudgetTime', 'Cutoff time'))}</span><input class="form-input" type="time" data-weekly-time required></label>
      <label class="banking-field"><span>${esc(localized('weeklyBudgetTimezone', 'Timezone'))}</span><input class="form-input" value="Europe/Berlin" data-weekly-timezone required></label>
      <label class="banking-field"><span>${esc(localized('weeklyBudgetSyncOne', 'First daily sync'))}</span><input class="form-input" type="time" data-weekly-sync-one required></label>
      <label class="banking-field"><span>${esc(localized('weeklyBudgetSyncTwo', 'Second daily sync'))}</span><input class="form-input" type="time" data-weekly-sync-two required></label>
      <label class="banking-field banking-field--checkbox"><input type="checkbox" data-weekly-notifications-enabled><span>${esc(localized('weeklyBudgetNotifications', 'Send Banking notification'))}</span></label>
      <label class="banking-field"><span>${esc(localized('weeklyBudgetNotificationRecipient', 'Notification recipient'))}</span><select class="form-input" data-weekly-notification-recipient></select></label>
      <label class="banking-field banking-field--checkbox"><input type="checkbox" data-weekly-notification-qr-preview><span>${esc(localized('weeklyBudgetNotificationQrPreview', 'Include QR preview in notification'))}</span></label>
      <div class="banking-weekly-settings__actions"><button class="btn btn--primary" type="submit" data-action="save-weekly-budget">${esc(localized('weeklyBudgetSave', 'Save settings'))}</button></div>
      <p class="banking-feedback" data-weekly-budget-feedback role="status"></p>
    </form>
  `;
}

function renderTransactionsPanelMarkup() {
  return `
    <details class="banking-panel banking-transactions-panel" data-banking-transactions-panel open>
      <summary>${esc(localized('transactions', 'Transactions'))}</summary>
      <div class="banking-transactions-panel__body" data-banking-transactions>
        <div data-transaction-filters></div>
        <div class="banking-transactions-table-wrap" data-banking-transactions-table><p class="banking-muted">${esc(localized('loading', 'Loading ...'))}</p></div>
        <div data-banking-transactions-pagination></div>
      </div>
    </details>
  `;
}

function configureMainInteractions(container, permission, signal) {
  const canWrite = permission === 'write';
  const reloadWeeklyBudget = container.querySelector('[data-action="reload-weekly-budget"]');
  const weeklyCategories = container.querySelector('[data-weekly-budget-categories]');
  const categorizationHost = container.querySelector('[data-banking-categorization]');
  const runCategorizationButton = container.querySelector('[data-action="run-categorization"]');
  const weeklyHistory = container.querySelector('[data-weekly-budget-history]');
  const accountsHost = container.querySelector('[data-banking-accounts]');
  const accountsPanel = container.querySelector('[data-banking-accounts-panel]');
  const transactionsHost = container.querySelector('[data-banking-transactions]');
  const transactionsPanel = container.querySelector('[data-banking-transactions-panel]');

  if (!canWrite) runCategorizationButton.disabled = true;
  reloadWeeklyBudget.addEventListener('click', () => {
    void refreshWeeklyBudget(container, signal, canWrite);
  }, { signal });
  if (weeklyCategories) weeklyCategories.addEventListener('change', (event) => {
    const checkbox = event.target.closest('input[data-weekly-category-id]');
    if (checkbox) void updateCategoryWeeklyBudget({ container, checkbox, signal });
  }, { signal });
  runCategorizationButton.addEventListener('click', () => {
    void runCategorization({ container, host: categorizationHost, button: runCategorizationButton, signal });
  }, { signal });
  categorizationHost.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-categorization-suggestion-id]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'accept-category-suggestion' || action === 'dismiss-category-suggestion') {
      void decideCategorySuggestion({ container, host: categorizationHost, button, action, signal });
    }
  }, { signal });
  weeklyHistory.addEventListener('click', (event) => {
    const actionButton = event.target.closest('button[data-action]');
    if (actionButton?.dataset.action === 'recalculate-weekly-period') {
      void recalculateWeeklyBudgetPeriod({ container, button: actionButton, signal });
      return;
    }
    if (actionButton?.dataset.action === 'dismiss-weekly-transfer') {
      void dismissWeeklyBudgetTransfer({ container, button: actionButton, signal });
      return;
    }
    const button = event.target.closest('button[data-weekly-period-id]');
    if (button) void toggleWeeklyBudgetPeriodDetails({ button, signal });
  }, { signal });
  accountsHost.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const card = button.closest('[data-banking-account-card]');
    if (button.dataset.action === 'show-account') void toggleAccountDetails({ card, button, signal });
    if (button.dataset.action === 'sync-account') void syncAccount({ container, card, button, signal });
    if (button.dataset.action === 'load-merchant-logos') void loadMerchantLogos({ container, card, button, signal });
  }, { signal });
  transactionsHost.addEventListener('change', (event) => {
    const filter = event.target.closest('[data-transaction-filter]');
    if (filter) {
      updateTransactionFilterState(container, filter);
      if (filter.dataset.transactionFilter !== 'q') void loadTransactionTable({ container, signal });
      return;
    }
    const select = event.target.closest('select[data-weekly-budget-override]');
    if (select) {
      void updateTransactionWeeklyBudget({ container, select, signal });
      return;
    }
    const categorySelect = event.target.closest('select[data-transaction-category-id]');
    if (categorySelect) void updateTransactionCategory({ container, select: categorySelect, signal });
  }, { signal });
  transactionsHost.addEventListener('submit', (event) => {
    const form = event.target.closest('[data-transaction-filters]');
    if (!form) return;
    event.preventDefault();
    updateTransactionFilterState(container, form);
    void loadTransactionTable({ container, signal });
  }, { signal });
  transactionsHost.addEventListener('input', (event) => {
    const input = event.target.closest('[data-transaction-filter="q"]');
    if (!input) return;
    clearTimeout(container.bankingTransactionDebounce);
    updateTransactionFilterState(container, input);
    container.bankingTransactionDebounce = setTimeout(() => {
      void loadTransactionTable({ container, signal });
    }, 250);
  }, { signal });
  transactionsHost.addEventListener('click', (event) => {
    const sortButton = event.target.closest('[data-transaction-sort]');
    if (sortButton) {
      updateTransactionSort(container, sortButton.dataset.transactionSort);
      void loadTransactionTable({ container, signal });
      return;
    }
    const pageButton = event.target.closest('[data-transaction-page]');
    if (pageButton && !pageButton.disabled) {
      const state = container.bankingTransactionState;
      state.offset = Math.max(0, state.offset + Number(pageButton.dataset.transactionPage) * state.limit);
      void loadTransactionTable({ container, signal });
      return;
    }
    if (event.target.closest('[data-action="reset-transaction-filters"]')) {
      resetTransactionFilters(container);
      void loadTransactionTable({ container, signal });
    }
  }, { signal });
  transactionsPanel.addEventListener('toggle', () => {
    try {
      sessionStorage.setItem('yuvomi:banking:transactions-open', String(transactionsPanel.open));
    } catch {
      // A blocked sessionStorage must not affect the banking view.
    }
  }, { signal });
  try {
    if (sessionStorage.getItem('yuvomi:banking:transactions-open') === 'false') transactionsPanel.open = false;
  } catch {
    // Ignore storage restrictions.
  }
  accountsPanel.addEventListener('toggle', () => {
    try {
      sessionStorage.setItem('yuvomi:banking:accounts-open', accountsPanel.open ? '1' : '0');
    } catch {
      // A blocked sessionStorage must not affect the banking view.
    }
  }, { signal });
  try {
    if (sessionStorage.getItem('yuvomi:banking:accounts-open') === '0') accountsPanel.open = false;
  } catch {
    // Ignore storage restrictions.
  }
}

function configureSettingsInteractions(container, permission, signal) {
  const canWrite = permission === 'write';
  const form = container.querySelector('[data-banking-connect-form]');
  const country = container.querySelector('[data-banking-country]');
  const bank = container.querySelector('[data-banking-bank]');
  const loadButton = container.querySelector('[data-action="load-banks"]');
  const connectButton = container.querySelector('[data-action="connect-bank"]');
  const feedback = container.querySelector('[data-banking-connect-feedback]');
  const weeklySettings = container.querySelector('[data-weekly-budget-settings]');
  const weeklyCategories = container.querySelector('[data-weekly-budget-categories]');
  const pushHost = container.querySelector('[data-banking-push]');
  const enablePushButton = container.querySelector('[data-action="enable-banking-push"]');
  const testPushButton = container.querySelector('[data-action="test-banking-push"]');
  const aspspsByName = new Map();

  if (!canWrite) {
    feedback.textContent = localized('readOnly', 'Your Banking permission is read-only.');
    for (const control of [country, bank, loadButton, connectButton, enablePushButton, testPushButton]) {
      control.disabled = true;
    }
  }
  loadButton.addEventListener('click', () => {
    void loadBanks({ country, bank, connectButton, loadButton, feedback, aspspsByName, signal });
  }, { signal });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void startConnection({ country, bank, connectButton, loadButton, feedback, aspspsByName, signal });
  }, { signal });
  country.addEventListener('change', () => {
    bank.replaceChildren(createOption('', localized('loadBanksFirst', 'Load banks first')));
    aspspsByName.clear();
    bank.disabled = true;
    connectButton.disabled = true;
  }, { signal });
  weeklySettings.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveWeeklyBudgetSettings({ container, form: weeklySettings, signal });
  }, { signal });
  weeklyCategories.addEventListener('change', (event) => {
    const checkbox = event.target.closest('input[data-weekly-category-id]');
    if (checkbox) void updateCategoryWeeklyBudget({ container, checkbox, signal });
  }, { signal });
  enablePushButton.addEventListener('click', () => {
    void enableBankingPush({ container, button: enablePushButton, signal });
  }, { signal });
  testPushButton.addEventListener('click', () => {
    void enqueueBankingPushTest({ container, button: testPushButton, signal });
  }, { signal });
  pushHost.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-banking-push-subscription-id]');
    if (button) void disableBankingPushSubscription({ container, button, signal });
  }, { signal });
}

async function loadMainView(container, signal, canWrite) {
  const accountsHost = container.querySelector('[data-banking-accounts]');
  const weeklyBudgetHost = container.querySelector('[data-weekly-budget-current]');
  const categoriesHost = container.querySelector('[data-weekly-budget-categories]');
  const historyHost = container.querySelector('[data-weekly-budget-history]');
  const categorizationHost = container.querySelector('[data-banking-categorization]');
  const [accountsResult, weeklyBudgetResult, categoriesResult, periodsResult, reviewsResult, suggestionsResult] = await Promise.allSettled([
    loadJson('accounts', { signal }),
    loadJson('weekly-budget/current', { signal }),
    loadJson('categories', { signal }),
    loadJson('weekly-budget/periods', { signal }),
    loadJson('categorization/reviews', { signal }),
    loadJson('category-suggestions', { signal })
  ]);
  if (signal.aborted) return;
  const accounts = accountsResult.status === 'fulfilled' && Array.isArray(accountsResult.value?.data) ? accountsResult.value.data : [];
  const categories = categoriesResult.status === 'fulfilled' && Array.isArray(categoriesResult.value?.data) ? categoriesResult.value.data : [];
  if (accountsResult.status === 'fulfilled') renderAccounts(accountsHost, accounts, canWrite);
  else renderError(accountsHost, accountsResult.reason);
  if (weeklyBudgetResult.status === 'fulfilled') renderWeeklyBudget(weeklyBudgetHost, null, weeklyBudgetResult.value?.data, accounts, canWrite);
  else renderError(weeklyBudgetHost, weeklyBudgetResult.reason);
  if (categoriesHost && categoriesResult.status === 'fulfilled') renderWeeklyBudgetCategories(categoriesHost, categories, canWrite);
  else if (categoriesHost) renderError(categoriesHost, categoriesResult.reason);
  if (periodsResult.status === 'fulfilled') renderWeeklyBudgetHistory(historyHost, periodsResult.value?.data, canWrite);
  else renderError(historyHost, periodsResult.reason);
  if (reviewsResult.status === 'fulfilled') renderCategorizationReviews(categorizationHost, reviewsResult.value?.data);
  else renderError(categorizationHost.querySelector('[data-categorization-reviews]'), reviewsResult.reason);
  if (suggestionsResult.status === 'fulfilled') renderCategorySuggestions(categorizationHost, suggestionsResult.value?.data, canWrite);
  else renderError(categorizationHost.querySelector('[data-categorization-suggestions]'), suggestionsResult.reason);
  container.bankingTransactionState = createTransactionState();
  container.bankingTransactionAccounts = accounts;
  container.bankingTransactionCategories = categories;
  renderTransactionFilters(container.querySelector('[data-banking-transactions]'), accounts, categories, container.bankingTransactionState);
  await loadTransactionTable({ container, signal, categories });
}

async function loadSettingsView(container, signal, canWrite) {
  const connectionsHost = container.querySelector('[data-banking-connections]');
  const weeklyBudgetHost = container.querySelector('[data-weekly-budget-current]');
  const categoriesHost = container.querySelector('[data-weekly-budget-categories]');
  const [connectionsResult, accountsResult, weeklyBudgetResult, categoriesResult, recipientsResult, usersResult] = await Promise.allSettled([
    loadJson('connections', { signal }),
    loadJson('accounts', { signal }),
    loadJson('weekly-budget/current', { signal }),
    loadJson('categories', { signal }),
    loadJson('push/recipients', { signal }),
    api.get('/auth/users')
  ]);
  if (signal.aborted) return;
  if (connectionsResult.status === 'fulfilled') {
    const connections = connectionsResult.value?.data;
    renderConnections(connectionsHost, connections);
    const callbackState = new URLSearchParams(window.location.search).get('banking');
    const panel = container.querySelector('[data-banking-connections-panel]');
    if (panel && callbackState !== 'error' && callbackState !== 'connected') panel.open = !Array.isArray(connections) || !connections.some((item) => item?.status === 'authorized');
  } else renderError(connectionsHost, connectionsResult.reason);
  const accounts = accountsResult.status === 'fulfilled' && Array.isArray(accountsResult.value?.data) ? accountsResult.value.data : [];
  if (weeklyBudgetResult.status === 'fulfilled') {
    renderWeeklyBudget(weeklyBudgetHost, container.querySelector('[data-weekly-budget-settings]'), weeklyBudgetResult.value?.data, accounts, canWrite, recipientsResult.status === 'fulfilled' ? recipientsResult.value?.data : [], usersResult.status === 'fulfilled' ? usersResult.value?.data : []);
  } else renderError(weeklyBudgetHost, weeklyBudgetResult.reason);
  if (categoriesResult.status === 'fulfilled') renderWeeklyBudgetCategories(categoriesHost, categoriesResult.value?.data, canWrite);
  else renderError(categoriesHost, categoriesResult.reason);
  await loadBankingPushPanel(container, signal, canWrite);
}

function createTransactionState() {
  return { q: '', accountId: '', categoryId: '', uncategorized: false, direction: '', status: '', dateFrom: '', dateTo: '', sort: 'date', order: 'desc', limit: 50, offset: 0, requestId: 0, controller: null };
}

async function loadBankingPushPanel(container, signal, canWrite) {
  const feedback = container.querySelector('[data-banking-push-feedback]');
  const subscriptionsHost = container.querySelector('[data-banking-push-subscriptions]');
  const enableButton = container.querySelector('[data-action="enable-banking-push"]');
  const testButton = container.querySelector('[data-action="test-banking-push"]');
  const [vapidResult, subscriptionsResult] = await Promise.allSettled([
    loadJson('push/vapid-public-key', { signal }),
    loadJson('push/subscriptions', { signal })
  ]);
  if (signal.aborted) return;
  const configured = vapidResult.status === 'fulfilled'
    && typeof vapidResult.value?.data?.public_key === 'string';
  const supported = supportsBankingPush();
  enableButton.disabled = !canWrite || !configured || !supported;
  testButton.disabled = !canWrite || !configured;
  if (!canWrite) {
    feedback.textContent = localized('readOnly', 'Your Banking permission is read-only.');
  } else if (!supported) {
    feedback.textContent = localized('pushUnsupported', 'This browser does not support Banking notifications.');
  } else if (!configured) {
    feedback.textContent = localized('pushUnavailable', 'Banking notifications are not configured on this server.');
  } else if (Notification.permission === 'denied') {
    feedback.textContent = localized('pushDenied', 'Notifications are blocked in this browser.');
  } else {
    feedback.textContent = Notification.permission === 'granted'
      ? localized('pushReady', 'Notifications are enabled for this browser.')
      : localized('pushReadyToEnable', 'Enable notifications only if you want Banking alerts on this device.');
  }
  const subscriptions = subscriptionsResult.status === 'fulfilled'
    && Array.isArray(subscriptionsResult.value?.data)
    ? subscriptionsResult.value.data
    : [];
  renderBankingPushSubscriptions(subscriptionsHost, subscriptions, canWrite);
}

function renderBankingPushSubscriptions(host, subscriptions, canWrite) {
  host.replaceChildren();
  if (!subscriptions.length) {
    host.insertAdjacentHTML('beforeend', `<p class="banking-muted">${esc(localized('pushNoDevices', 'No Banking device is registered.'))}</p>`);
    return;
  }
  const rows = subscriptions.map((subscription) => `
    <li>
      <span>${esc(subscription?.device_name || localized('pushUnnamedDevice', 'This device'))}</span>
      <small>${esc(subscription?.status === 'active'
        ? localized('pushActive', 'Active')
        : localized('pushDisabled', 'Disabled'))}</small>
      ${canWrite && subscription?.status === 'active' && /^\d+$/.test(String(subscription?.id ?? ''))
        ? `<button class="btn btn--secondary" type="button" data-banking-push-subscription-id="${esc(String(subscription.id))}">${esc(localized('pushRemove', 'Remove'))}</button>`
        : ''}
    </li>
  `).join('');
  host.insertAdjacentHTML('beforeend', `<ul class="banking-list">${rows}</ul>`);
}

async function enableBankingPush({ container, button, signal }) {
  const feedback = container.querySelector('[data-banking-push-feedback]');
  button.disabled = true;
  feedback.textContent = localized('pushEnabling', 'Enabling Banking notifications ...');
  try {
    if (!supportsBankingPush()) {
      throw new Error(localized('pushUnsupported', 'This browser does not support Banking notifications.'));
    }
    const vapid = await loadJson('push/vapid-public-key', { signal });
    const publicKey = vapid?.data?.public_key;
    if (typeof publicKey !== 'string' || !publicKey) {
      throw new Error(localized('pushUnavailable', 'Banking notifications are not configured on this server.'));
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error(localized('pushDenied', 'Notifications are blocked in this browser.'));
    const registration = await navigator.serviceWorker.register('/modules/banking/push-worker.js', {
      scope: '/modules/banking/'
    });
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing ?? await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
    const csrf = await loadJson('csrf', { signal });
    await loadJson('push/subscriptions', {
      method: 'POST',
      headers: { 'x-banking-csrf': csrf?.csrf_token ?? '' },
      body: { subscription: subscription.toJSON(), device_name: localized('pushThisDevice', 'This device') },
      signal
    });
    feedback.textContent = localized('pushEnabled', 'Banking notifications are enabled on this device.');
    await loadBankingPushPanel(container, signal, true);
  } catch (error) {
    if (!signal.aborted) feedback.textContent = error instanceof Error
      ? error.message
      : localized('pushEnableFailed', 'Banking notifications could not be enabled.');
  } finally {
    if (!signal.aborted) button.disabled = false;
  }
}

async function disableBankingPushSubscription({ container, button, signal }) {
  const id = button.dataset.bankingPushSubscriptionId;
  if (!/^\d+$/.test(id)) return;
  const feedback = container.querySelector('[data-banking-push-feedback]');
  button.disabled = true;
  try {
    const csrf = await loadJson('csrf', { signal });
    await loadJson(`push/subscriptions/${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: { 'x-banking-csrf': csrf?.csrf_token ?? '' }, signal
    });
    feedback.textContent = localized('pushRemoved', 'Banking device removed.');
    await loadBankingPushPanel(container, signal, true);
  } catch (error) {
    if (!signal.aborted) feedback.textContent = error instanceof Error
      ? error.message
      : localized('pushRemoveFailed', 'Banking device could not be removed.');
  } finally {
    if (!signal.aborted) button.disabled = false;
  }
}

async function enqueueBankingPushTest({ container, button, signal }) {
  const feedback = container.querySelector('[data-banking-push-feedback]');
  button.disabled = true;
  try {
    const csrf = await loadJson('csrf', { signal });
    const result = await loadJson('push/test', {
      method: 'POST', headers: { 'x-banking-csrf': csrf?.csrf_token ?? '' }, body: {}, signal
    });
    feedback.textContent = Number(result?.data?.queued) > 0
      ? localized('pushTestQueued', 'Test notification queued.')
      : localized('pushNoDevices', 'No Banking device is registered.');
  } catch (error) {
    if (!signal.aborted) feedback.textContent = error instanceof Error
      ? error.message
      : localized('pushTestFailed', 'Test notification could not be queued.');
  } finally {
    if (!signal.aborted) button.disabled = false;
  }
}

function supportsBankingPush() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlBase64ToUint8Array(value) {
  const padded = `${value}${'='.repeat((4 - value.length % 4) % 4)}`
    .replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(padded);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

async function loadBanks({ country, bank, connectButton, loadButton, feedback, aspspsByName, signal }) {
  loadButton.disabled = true;
  connectButton.disabled = true;
  feedback.textContent = localized('loadingBanks', 'Loading banks ...');
  try {
    const payload = await loadJson(`aspsps?country=${encodeURIComponent(country.value)}`, { signal });
    const aspsps = Array.isArray(payload?.data) ? payload.data : [];
    const unique = new Map();
    aspspsByName.clear();
    for (const aspsp of aspsps) {
      const name = typeof aspsp?.name === 'string' ? aspsp.name.trim() : '';
      if (name && !unique.has(name)) {
        unique.set(name, aspsp);
        aspspsByName.set(name, aspsp);
      }
    }

    bank.replaceChildren();
    bank.append(createOption('', localized('chooseBank', 'Choose a bank')));
    for (const name of [...unique.keys()].sort((left, right) => left.localeCompare(right))) {
      bank.append(createOption(name, name));
    }
    bank.disabled = unique.size === 0;
    feedback.textContent = unique.size
      ? localized('banksLoaded', 'Select a bank to continue.')
      : localized('noBanks', 'No banks found for this country.');
    bank.addEventListener('change', () => {
      connectButton.disabled = !bank.value;
    }, { signal });
  } catch (error) {
    bank.replaceChildren(createOption('', localized('loadBanksFirst', 'Load banks first')));
    bank.disabled = true;
    feedback.textContent = error instanceof Error
      ? error.message
      : localized('providerUnavailable', 'Enable Banking sandbox is not available.');
  } finally {
    loadButton.disabled = false;
  }
}

async function startConnection({ country, bank, connectButton, loadButton, feedback, aspspsByName, signal }) {
  if (!bank.value || !aspspsByName.has(bank.value)) return;
  connectButton.disabled = true;
  loadButton.disabled = true;
  feedback.textContent = localized('startingConnection', 'Starting bank connection ...');
  try {
    const csrf = await loadJson('csrf', { signal });
    const payload = await loadJson('enablebanking/start', {
      method: 'POST',
      headers: { 'x-banking-csrf': csrf?.csrf_token ?? '' },
      body: { country: country.value, name: bank.value },
      signal
    });
    const providerUrl = payload?.data?.url;
    if (typeof providerUrl !== 'string' || !providerUrl) throw new Error(
      localized('invalidProviderUrl', 'The bank authorization URL is invalid.')
    );
    window.location.assign(providerUrl);
  } catch (error) {
    feedback.textContent = error instanceof Error
      ? error.message
      : localized('providerUnavailable', 'Enable Banking sandbox is not available.');
    connectButton.disabled = false;
    loadButton.disabled = false;
  }
}

function renderCategorizationReviews(host, reviews) {
  const reviewsHost = host.querySelector('[data-categorization-reviews]');
  reviewsHost.replaceChildren();
  if (!Array.isArray(reviews) || reviews.length === 0) {
    reviewsHost.insertAdjacentHTML('beforeend', `<p class="banking-muted">${esc(localized('categorizationNoReviews', 'No categorization review is pending.'))}</p>`);
    return;
  }
  const rows = reviews.map((review) => {
    const title = review?.merchant_name || review?.counterparty_name || review?.purpose || localized('unknownTransaction', 'Transaction');
    const proposed = review?.category_name || review?.suggested_category_name || localized('categorizationNoMatch', 'No allowed category suggested');
    const confidence = Number.isFinite(Number(review?.confidence))
      ? `${Math.round(Number(review.confidence) * 100)} %`
      : '';
    return `<li>
      <span><strong>${esc(String(title))}</strong><small>${esc(`${proposed}${confidence ? ` · ${confidence}` : ''}${review?.reason ? ` · ${review.reason}` : ''}`)}</small></span>
    </li>`;
  }).join('');
  reviewsHost.insertAdjacentHTML('beforeend', `<ul class="banking-transaction-list">${rows}</ul>`);
}

function renderCategorySuggestions(host, suggestions, canWrite) {
  const suggestionsHost = host.querySelector('[data-categorization-suggestions]');
  suggestionsHost.replaceChildren();
  suggestionsHost.insertAdjacentHTML('beforeend', `<h4>${esc(localized('categorizationSuggestionsTitle', 'Suggested categories'))}</h4>`);
  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    suggestionsHost.insertAdjacentHTML('beforeend', `<p class="banking-muted">${esc(localized('categorizationNoSuggestions', 'No category suggestions are pending.'))}</p>`);
    return;
  }
  const rows = suggestions.map((suggestion) => {
    const id = String(suggestion?.id ?? '');
    const name = typeof suggestion?.suggested_name === 'string' ? suggestion.suggested_name : '';
    const type = typeof suggestion?.suggested_type === 'string' ? suggestion.suggested_type : '';
    const samples = Number.isSafeInteger(Number(suggestion?.sample_count))
      ? Number(suggestion.sample_count)
      : 0;
    const reason = typeof suggestion?.reason === 'string' ? suggestion.reason : '';
    const details = [type, localized('categorizationSamples', '{count} samples', { count: samples }), reason]
      .filter(Boolean)
      .join(' · ');
    const actions = canWrite && /^\d+$/.test(id) ? `
      <span class="banking-categorization__actions">
        <button class="btn btn--secondary" type="button" data-action="accept-category-suggestion" data-categorization-suggestion-id="${esc(id)}">${esc(localized('categorizationAcceptSuggestion', 'Accept category'))}</button>
        <button class="btn btn--secondary" type="button" data-action="dismiss-category-suggestion" data-categorization-suggestion-id="${esc(id)}">${esc(localized('categorizationDismissSuggestion', 'Dismiss'))}</button>
      </span>` : '';
    return `<li>
      <span><strong>${esc(name || localized('categorizationNoMatch', 'No allowed category suggested'))}</strong><small>${esc(details)}</small></span>
      ${actions}
    </li>`;
  }).join('');
  suggestionsHost.insertAdjacentHTML('beforeend', `<ul class="banking-transaction-list">${rows}</ul>`);
}

async function refreshCategorizationReviews(container, signal) {
  const host = container.querySelector('[data-banking-categorization]');
  if (!host) return;
  try {
    const result = await loadJson('categorization/reviews', { signal });
    if (!signal.aborted) renderCategorizationReviews(host, result?.data);
  } catch (error) {
    if (!signal.aborted) {
      renderError(host.querySelector('[data-categorization-reviews]'), error);
    }
  }
}

async function decideCategorySuggestion({ container, host, button, action, signal }) {
  const suggestionId = button.dataset.categorizationSuggestionId;
  if (!/^\d+$/.test(suggestionId || '')) return;
  const feedback = host.querySelector('[data-categorization-feedback]');
  button.disabled = true;
  try {
    const csrf = await loadJson('csrf', { signal });
    await loadJson(`category-suggestions/${encodeURIComponent(suggestionId)}/${action === 'accept-category-suggestion' ? 'accept' : 'dismiss'}`, {
      method: 'POST',
      headers: { 'x-banking-csrf': csrf?.csrf_token ?? '' },
      body: {},
      signal
    });
    if (signal.aborted) return;
    await loadMainView(container, signal, true);
    const refreshedFeedback = container.querySelector('[data-categorization-feedback]');
    if (refreshedFeedback) {
      refreshedFeedback.textContent = action === 'accept-category-suggestion'
        ? localized('categorizationSuggestionAccepted', 'Category accepted.')
        : localized('categorizationSuggestionDismissed', 'Category suggestion dismissed.');
    }
  } catch (error) {
    if (!signal.aborted && feedback) feedback.textContent = error instanceof Error
      ? error.message
      : localized('categorizationSuggestionFailed', 'Category suggestion could not be updated.');
  } finally {
    if (!signal.aborted) button.disabled = false;
  }
}

async function runCategorization({ container, host, button, signal }) {
  const feedback = host.querySelector('[data-categorization-feedback]');
  button.disabled = true;
  feedback.textContent = localized('categorizationRunning', 'Analyzing unresolved transactions ...');
  try {
    const csrf = await loadJson('csrf', { signal });
    const result = await loadJson('categorization/run', {
      method: 'POST',
      headers: { 'x-banking-csrf': csrf?.csrf_token ?? '' },
      body: {},
      signal
    });
    if (signal.aborted) return;
    const data = result?.data ?? {};
    feedback.textContent = localized('categorizationDone', '{applied} applied, {review} awaiting review.', {
      applied: data.applied ?? 0,
      review: data.pendingReview ?? 0
    });
    await loadMainView(container, signal, true);
  } catch (error) {
    if (!signal.aborted) feedback.textContent = error instanceof Error
      ? error.message
      : localized('categorizationFailed', 'Transactions could not be categorized.');
  } finally {
    if (!signal.aborted) button.disabled = false;
  }
}

function renderWeeklyBudget(host, form, current, accounts, canWrite, recipients = [], users = []) {
  host.replaceChildren();
  const configured = current?.configured === true;
  const enabled = configured && current?.enabled !== false;
  const settings = configured ? current?.settings : null;

  if (!configured) {
    host.insertAdjacentHTML('beforeend', `
      <p class="banking-muted">${esc(localized('weeklyBudgetNotConfigured', 'Weekly budget is not configured yet.'))}</p>
    `);
  } else if (!enabled) {
    host.insertAdjacentHTML('beforeend', `
      <p class="banking-muted">${esc(localized('weeklyBudgetDisabled', 'Weekly budget is currently disabled.'))}</p>
    `);
  } else {
    const calculation = current?.provisional_calculation;
    const balance = current?.balance;
    host.insertAdjacentHTML('beforeend', `
      <div class="banking-weekly-summary">
        ${weeklySummaryCard(
          localized('weeklyBudgetAvailable', 'Available on N26'),
          formatCents(current?.available_to_spend_cents, settings?.currency),
          balance?.stale ? localized('weeklyBudgetStale', 'Balance is stale') : formatDateTime(balance?.fetched_at)
        )}
        ${weeklySummaryCard(
          localized('weeklyBudgetDirect', 'Sparkasse direct expenses'),
          formatCents(current?.direct_expense_cents, settings?.currency),
          localized('weeklyBudgetDirectCount', '{count} included transactions', {
            count: Array.isArray(current?.direct_expenses) ? current.direct_expenses.length : 0
          })
        )}
        ${weeklySummaryCard(
          localized('weeklyBudgetNextTransfer', 'Current refill calculation'),
          calculation
            ? formatCents(calculation.transfer_amount_cents, settings?.currency)
            : localized('weeklyBudgetNoCalculation', 'No reliable calculation'),
          localized('weeklyBudgetNextCutoff', 'Next cutoff: {date}', {
            date: formatDateTime(current?.period?.next_cutoff_at)
          })
        )}
      </div>
      ${weeklyGiroCodeMarkup(current?.latest_suggestion)}
    `);
    configureGiroCodeShare(host);
  }

  if (!form) return;

  fillAccountSelect(
    form.querySelector('[data-weekly-source]'),
    accounts,
    settings?.source_account?.id,
    localized('weeklyBudgetChooseSource', 'Choose source account')
  );
  fillAccountSelect(
    form.querySelector('[data-weekly-target]'),
    accounts,
    settings?.target_account?.id,
    localized('weeklyBudgetChooseTarget', 'Choose target account')
  );
  form.querySelector('[data-weekly-enabled]').checked = settings?.enabled ?? true;
  form.querySelector('[data-weekly-amount]').value = settings
    ? centsToInput(settings.target_amount_cents)
    : '450,00';
  form.querySelector('[data-weekly-weekday]').value = String(settings?.cutoff_weekday ?? 7);
  form.querySelector('[data-weekly-time]').value = settings?.cutoff_time ?? '18:30';
  form.querySelector('[data-weekly-timezone]').value = settings?.timezone ?? 'Europe/Berlin';
  form.querySelector('[data-weekly-sync-one]').value = settings?.sync_time_1 ?? '06:00';
  form.querySelector('[data-weekly-sync-two]').value = settings?.sync_time_2 ?? '18:00';
  form.querySelector('[data-weekly-beneficiary]').value = settings?.target_beneficiary_name ?? '';
  const notificationEnabled = form.querySelector('[data-weekly-notifications-enabled]');
  const notificationRecipient = form.querySelector('[data-weekly-notification-recipient]');
  notificationEnabled.checked = settings?.notification_enabled === true;
  form.querySelector('[data-weekly-notification-qr-preview]').checked = settings?.notification_qr_preview === true;
  fillPushRecipientSelect(
    notificationRecipient,
    recipients,
    users,
    settings?.notification_user_id,
    localized('weeklyBudgetChooseNotificationRecipient', 'Choose a reachable recipient')
  );
  form.dataset.balanceStaleAfterMinutes = String(settings?.balance_stale_after_minutes ?? 840);
  form.dataset.notificationEnabled = String(settings?.notification_enabled ?? false);
  form.dataset.notificationUserId = settings?.notification_user_id == null
    ? ''
    : String(settings.notification_user_id);
  form.dataset.notificationQrPreview = String(settings?.notification_qr_preview ?? false);
  form.dataset.purposePrefix = settings?.purpose_prefix ?? 'WB';

  const noAccountChoice = accounts.length < 2;
  for (const control of form.elements) {
    control.disabled = !canWrite || noAccountChoice;
  }
  const feedback = form.querySelector('[data-weekly-budget-feedback]');
  if (noAccountChoice) {
    feedback.textContent = localized(
      'weeklyBudgetNeedsAccounts',
      'Connect at least two EUR accounts before configuring the weekly budget.'
    );
  } else if (!canWrite) {
    feedback.textContent = localized('readOnly', 'Your Banking permission is read-only.');
  } else {
    feedback.textContent = '';
  }
}

function fillPushRecipientSelect(select, recipients, users, selectedId, placeholder) {
  const namesById = new Map((Array.isArray(users) ? users : []).map((user) => [
    Number(user?.id), typeof user?.display_name === 'string' ? user.display_name : ''
  ]));
  select.replaceChildren(createOption('', placeholder));
  for (const recipient of Array.isArray(recipients) ? recipients : []) {
    const id = Number(recipient?.yuvomi_user_id);
    if (!Number.isSafeInteger(id) || id < 1) continue;
    const displayName = namesById.get(id) || localized('weeklyBudgetUserFallback', 'Yuvomi user #{id}', { id });
    const count = Number(recipient?.subscription_count);
    select.append(createOption(String(id), Number.isSafeInteger(count) && count > 1
      ? `${displayName} (${count})`
      : displayName));
  }
  select.value = selectedId == null ? '' : String(selectedId);
}

function weeklyGiroCodeMarkup(suggestion) {
  const giroCode = suggestion?.girocode;
  if (!giroCode?.png_url) return '';
  return `
    <section class="banking-girocode" aria-label="${esc(localized('weeklyBudgetGiroCode', 'GiroCode'))}">
      <div class="banking-girocode__details">
        <h3>${esc(localized('weeklyBudgetGiroCode', 'GiroCode'))}</h3>
        <dl>
          <div><dt>${esc(localized('weeklyBudgetBeneficiaryShort', 'Recipient'))}</dt><dd>${esc(giroCode.beneficiary_name || '')}</dd></div>
          <div><dt>IBAN</dt><dd>${esc(giroCode.iban_masked || '')}</dd></div>
          <div><dt>${esc(localized('weeklyBudgetTransferAmount', 'Amount'))}</dt><dd>${esc(formatCents(giroCode.amount_cents, giroCode.currency))}</dd></div>
          <div><dt>${esc(localized('weeklyBudgetPurpose', 'Purpose'))}</dt><dd>${esc(giroCode.purpose || '')}</dd></div>
        </dl>
        <p class="banking-panel__description">${esc(localized('weeklyBudgetGiroCodeHint', 'Check the payment data, then scan the code with your banking app.'))}</p>
        <div class="banking-girocode__actions">
          <a class="btn btn--secondary" href="${esc(giroCode.png_url)}" target="_blank" rel="noopener">${esc(localized('weeklyBudgetOpenGiroCode', 'Open GiroCode'))}</a>
          <a class="btn btn--secondary" href="${esc(giroCode.png_url)}" download="weekly-budget-girocode.png">${esc(localized('weeklyBudgetDownloadGiroCode', 'Download PNG'))}</a>
          <button class="btn btn--secondary" type="button" data-action="share-girocode" data-girocode-url="${esc(giroCode.png_url)}">${esc(localized('weeklyBudgetShareGiroCode', 'Share'))}</button>
        </div>
      </div>
      <img src="${esc(giroCode.png_url)}" alt="${esc(localized('weeklyBudgetGiroCodeAlt', 'QR code for the weekly-budget transfer'))}">
    </section>
  `;
}

function configureGiroCodeShare(host) {
  const button = host.querySelector('[data-action="share-girocode"]');
  if (!button) return;
  if (typeof navigator.share !== 'function' || typeof File !== 'function') {
    button.remove();
    return;
  }
  button.addEventListener('click', () => {
    void shareGiroCode(button);
  });
}

async function shareGiroCode(button) {
  button.disabled = true;
  try {
    const response = await fetch(button.dataset.girocodeUrl, {
      credentials: 'same-origin',
      cache: 'no-store'
    });
    if (!response.ok) throw new Error('GiroCode unavailable.');
    const file = new File(
      [await response.blob()],
      'weekly-budget-girocode.png',
      { type: 'image/png' }
    );
    if (typeof navigator.canShare === 'function' && !navigator.canShare({ files: [file] })) {
      button.remove();
      return;
    }
    await navigator.share({
      title: localized('weeklyBudgetGiroCode', 'GiroCode'),
      files: [file]
    });
  } catch (error) {
    if (error?.name !== 'AbortError') button.title = localized(
      'weeklyBudgetShareFailed',
      'GiroCode could not be shared.'
    );
  } finally {
    button.disabled = false;
  }
}

function weeklySummaryCard(label, value, detail) {
  return `
    <article class="banking-weekly-summary__card">
      <span>${esc(label)}</span>
      <strong>${esc(value)}</strong>
      <small>${esc(detail || '')}</small>
    </article>
  `;
}

function renderWeeklyBudgetCategories(host, categories, canWrite) {
  host.replaceChildren();
  if (!Array.isArray(categories) || categories.length === 0) {
    host.insertAdjacentHTML('beforeend', `
      <p class="banking-muted">${esc(localized('weeklyBudgetNoCategories', 'No Banking categories available yet.'))}</p>
    `);
    return;
  }
  const rows = categories.map((category) => `
    <label class="banking-weekly-category${category?.active === false ? ' is-inactive' : ''}">
      <span>
        <strong>${esc(category?.name || localized('unknownTransaction', 'Category'))}</strong>
        <small>${esc(String(category?.type || ''))}</small>
      </span>
      <input type="checkbox" data-weekly-category-id="${esc(String(category?.id ?? ''))}"
        data-current-value="${category?.weekly_budget_default ? 'true' : 'false'}"
        ${category?.weekly_budget_default ? 'checked' : ''} ${canWrite ? '' : 'disabled'}>
    </label>
  `).join('');
  host.insertAdjacentHTML('beforeend', `<div class="banking-weekly-category-list">${rows}</div>`);
}

function renderWeeklyBudgetHistory(host, periods, canWrite) {
  host.replaceChildren();
  if (!Array.isArray(periods) || periods.length === 0) {
    host.insertAdjacentHTML('beforeend', `
      <p class="banking-muted">${esc(localized('weeklyBudgetNoHistory', 'No finalized weekly budgets yet.'))}</p>
    `);
    return;
  }
  const rows = periods.map((period) => {
    const suggestion = period?.latest_suggestion;
    const targetAmountCents = suggestion?.target_amount_cents ?? period?.target_amount_cents;
    const directExpenseCents = suggestion?.deducted_amount_cents ?? period?.direct_expense_cents;
    const targetBalanceCents = suggestion?.target_balance_cents ?? period?.target_balance_cents;
    const computedAmountCents = suggestion?.computed_amount_cents ?? period?.computed_amount_cents;
    const pendingLateCandidates = Number(suggestion?.pending_late_candidate_count) || 0;
    const formula = [
      formatCents(targetAmountCents, period?.currency),
      '-',
      formatCents(directExpenseCents, period?.currency),
      '-',
      formatCents(targetBalanceCents, period?.currency),
      '=',
      formatCents(computedAmountCents, period?.currency)
    ].join(' ');
    return `
      <article class="banking-weekly-period" data-weekly-period-card>
        <div class="banking-weekly-period__summary">
          <span>
            <strong>${esc(formatDate(period?.period_start_date))} – ${esc(formatDate(period?.period_end_date))}</strong>
            <small>${esc(`${period?.trigger || ''} · ${weeklyBudgetTransferStateLabel(suggestion?.transfer_state || period?.status)}`)}</small>
          </span>
          <strong>${esc(formatCents(computedAmountCents, period?.currency))}</strong>
        </div>
        <p class="banking-weekly-period__formula">${esc(formula)}</p>
        ${pendingLateCandidates > 0 ? `<p class="banking-panel__description">${esc(localized('weeklyBudgetLateCandidates', '{count} late booked transaction(s) are waiting for review.', { count: pendingLateCandidates }))}</p>` : ''}
        <div class="banking-weekly-period__actions">
          <button class="btn btn--secondary" type="button" data-weekly-period-id="${esc(String(period?.id ?? ''))}">${esc(localized('weeklyBudgetShowDetails', 'Show details'))}</button>
          ${canWrite && suggestion?.can_recalculate ? `<button class="btn btn--primary" type="button" data-action="recalculate-weekly-period" data-weekly-period-id="${esc(String(period?.id ?? ''))}">${esc(localized('weeklyBudgetRecalculate', 'Recalculate'))}</button>` : ''}
          ${canWrite && suggestion?.can_dismiss ? `<button class="btn btn--secondary" type="button" data-action="dismiss-weekly-transfer" data-weekly-suggestion-id="${esc(String(suggestion?.id ?? ''))}">${esc(localized('weeklyBudgetDismissSuggestion', 'Dismiss suggestion'))}</button>` : ''}
          ${suggestion?.girocode_url ? `<a class="btn btn--secondary" href="${esc(suggestion.girocode_url)}" target="_blank" rel="noopener">${esc(localized('weeklyBudgetOpenGiroCode', 'Open GiroCode'))}</a>` : ''}
        </div>
        <p class="banking-feedback" data-weekly-period-feedback role="status"></p>
        <div class="banking-weekly-period__details" data-weekly-period-details hidden></div>
      </article>
    `;
  }).join('');
  host.insertAdjacentHTML('beforeend', `<div class="banking-weekly-history-list">${rows}</div>`);
}

async function recalculateWeeklyBudgetPeriod({ container, button, signal }) {
  const periodId = button.dataset.weeklyPeriodId;
  if (!/^\d+$/.test(periodId || '')) return;
  const feedback = button.closest('[data-weekly-period-card]')?.querySelector('[data-weekly-period-feedback]');
  button.disabled = true;
  if (feedback) feedback.textContent = localized(
    'weeklyBudgetRecalculating',
    'Recalculating the transfer suggestion ...'
  );
  try {
    const csrf = await loadJson('csrf', { signal });
    await loadJson(`weekly-budget/periods/${encodeURIComponent(periodId)}/recalculate`, {
      method: 'POST',
      headers: { 'x-banking-csrf': csrf?.csrf_token ?? '' },
      body: {},
      signal
    });
    await refreshWeeklyBudget(container, signal, true);
  } catch (error) {
    if (!signal.aborted && feedback) {
      feedback.textContent = error instanceof Error
        ? error.message
        : localized('weeklyBudgetRecalculateFailed', 'The transfer suggestion could not be recalculated.');
    }
  } finally {
    if (!signal.aborted) button.disabled = false;
  }
}

async function dismissWeeklyBudgetTransfer({ container, button, signal }) {
  const suggestionId = button.dataset.weeklySuggestionId;
  if (!/^\d+$/.test(suggestionId || '')) return;
  if (!window.confirm(localized(
    'weeklyBudgetDismissConfirm',
    'Dismiss this transfer suggestion? The historical revision will be retained.'
  ))) return;
  const feedback = button.closest('[data-weekly-period-card]')?.querySelector('[data-weekly-period-feedback]');
  button.disabled = true;
  if (feedback) feedback.textContent = localized(
    'weeklyBudgetDismissing',
    'Dismissing transfer suggestion ...'
  );
  try {
    const csrf = await loadJson('csrf', { signal });
    await loadJson(`weekly-budget/transfers/${encodeURIComponent(suggestionId)}/dismiss`, {
      method: 'POST',
      headers: { 'x-banking-csrf': csrf?.csrf_token ?? '' },
      body: {},
      signal
    });
    await refreshWeeklyBudget(container, signal, true);
  } catch (error) {
    if (!signal.aborted && feedback) {
      feedback.textContent = error instanceof Error
        ? error.message
        : localized('weeklyBudgetDismissFailed', 'The transfer suggestion could not be dismissed.');
    }
  } finally {
    if (!signal.aborted) button.disabled = false;
  }
}

async function toggleWeeklyBudgetPeriodDetails({ button, signal }) {
  const card = button.closest('[data-weekly-period-card]');
  const details = card?.querySelector('[data-weekly-period-details]');
  if (!details) return;
  if (details.dataset.loaded === 'true') {
    details.hidden = !details.hidden;
    button.textContent = details.hidden
      ? localized('weeklyBudgetShowDetails', 'Show details')
      : localized('weeklyBudgetHideDetails', 'Hide details');
    return;
  }
  const periodId = button.dataset.weeklyPeriodId;
  if (!/^\d+$/.test(periodId || '')) return;
  button.disabled = true;
  details.hidden = false;
  details.textContent = localized('loading', 'Loading ...');
  try {
    const payload = await loadJson(`weekly-budget/periods/${encodeURIComponent(periodId)}`, { signal });
    details.replaceChildren();
    details.insertAdjacentHTML('beforeend', weeklyBudgetPeriodDetailsMarkup(payload?.data));
    details.dataset.loaded = 'true';
    button.textContent = localized('weeklyBudgetHideDetails', 'Hide details');
  } catch (error) {
    details.textContent = error instanceof Error
      ? error.message
      : localized('weeklyBudgetHistoryFailed', 'Weekly-budget details could not be loaded.');
  } finally {
    button.disabled = false;
  }
}

function weeklyBudgetPeriodDetailsMarkup(period) {
  const transactions = Array.isArray(period?.transactions) ? period.transactions : [];
  const suggestions = Array.isArray(period?.suggestions) ? period.suggestions : [];
  const balances = Array.isArray(period?.balance_snapshots) ? period.balance_snapshots : [];
  const syncRuns = Array.isArray(period?.sync_runs) ? period.sync_runs : [];
  const activeSuggestion = suggestions[0];
  const activeCalculation = activeSuggestion ?? period;
  const pendingLateCandidates = Number(period?.lifecycle?.pending_late_candidate_count) || 0;
  const balanceRows = balances.length > 0
    ? balances.map((balance) => {
        const account = balance?.account_role === 'source'
          ? period?.source_account?.display_name
          : period?.target_account?.display_name;
        const observed = formatDateTime(balance?.observed_at || balance?.fetched_at);
        return `
          <li>
            <span>${esc(account || localized('unknownAccount', 'Bank account'))}<small>${esc(`${balance?.normalized_balance_type || balance?.provider_balance_type || ''}${observed ? ` · ${observed}` : ''}`)}</small></span>
            <strong>${esc(formatCents(balance?.amount_cents, balance?.currency))}</strong>
          </li>
        `;
      }).join('')
    : `<li class="banking-muted">${esc(localized('weeklyBudgetNoBalanceSnapshots', 'No balance snapshots available.'))}</li>`;
  const transactionRows = transactions.length > 0
    ? transactions.map((transaction) => `
        <li>
          <span>${esc(transaction?.counterparty_name || localized('unknownTransaction', 'Transaction'))}<small>${esc(`${transaction?.category_name || transaction?.decision_source || ''}${transaction?.state === 'late_candidate' ? ` · ${localized('weeklyBudgetLateCandidate', 'Late booking awaiting review')}` : ''} · ${localized('weeklyBudgetRevision', 'Revision {revision}', { revision: transaction?.revision ?? '' })}`)}</small></span>
          <strong>${esc(formatCents(transaction?.amount_cents, transaction?.currency))}</strong>
        </li>
      `).join('')
    : `<li class="banking-muted">${esc(localized('weeklyBudgetNoDirectExpenses', 'No direct expenses in this period.'))}</li>`;
  const revisionRows = suggestions.length > 0
    ? suggestions.map((suggestion) => `
        <li>
          <span>
            ${esc(localized('weeklyBudgetRevision', 'Revision {revision}', { revision: suggestion?.revision ?? '' }))}
            <small>${esc(`${weeklyBudgetTransferStateLabel(suggestion?.transfer_state || suggestion?.status)}${suggestion?.purpose ? ` · ${suggestion.purpose}` : ''}`)}</small>
          </span>
          <strong>${esc(formatCents(suggestion?.computed_amount_cents, period?.currency))}</strong>
          ${suggestion?.girocode?.png_url ? `<a class="btn btn--secondary" href="${esc(suggestion.girocode.png_url)}" target="_blank" rel="noopener">${esc(localized('weeklyBudgetOpenGiroCode', 'Open GiroCode'))}</a>` : ''}
        </li>
      `).join('')
    : `<li class="banking-muted">${esc(localized('weeklyBudgetNoRevisions', 'No transfer revision available.'))}</li>`;
  const syncRows = syncRuns.length > 0
    ? syncRuns.map((run) => `
        <li>
          <span>${esc(`${run?.trigger || ''} · ${run?.status || ''}`)}<small>${esc(formatDateTime(run?.finished_at || run?.started_at || run?.scheduled_for))}</small></span>
          <small>${esc(`${localized('weeklyBudgetSource', 'Source account')}: ${run?.source_sync_status || '–'} · ${localized('weeklyBudgetTarget', 'Target account')}: ${run?.target_sync_status || '–'}`)}</small>
        </li>
      `).join('')
    : `<li class="banking-muted">${esc(localized('weeklyBudgetNoSyncHistory', 'No synchronization history available.'))}</li>`;
  return `
    <dl class="banking-weekly-period__calculation">
      <div><dt>${esc(localized('weeklyBudgetAmount', 'Weekly target'))}</dt><dd>${esc(formatCents(activeCalculation?.target_amount_cents, period?.currency))}</dd></div>
      <div><dt>${esc(localized('weeklyBudgetClosingBalance', 'Target closing balance'))}</dt><dd>${esc(formatCents(activeCalculation?.target_balance_cents, period?.currency))}</dd></div>
      <div><dt>${esc(localized('weeklyBudgetDirect', 'Direct expenses'))}</dt><dd>${esc(formatCents(activeCalculation?.deducted_amount_cents ?? period?.direct_expense_cents, period?.currency))}</dd></div>
      <div><dt>${esc(localized('weeklyBudgetTransferAmount', 'Transfer'))}</dt><dd>${esc(formatCents(activeCalculation?.computed_amount_cents, period?.currency))}</dd></div>
      <div><dt>${esc(localized('weeklyBudgetActualTransfer', 'Detected transfer'))}</dt><dd>${esc(activeSuggestion?.matched_transaction_id || activeSuggestion?.matched_source_transaction_id || activeSuggestion?.matched_target_transaction_id ? formatCents(activeSuggestion?.computed_amount_cents, period?.currency) : '–')}</dd></div>
      <div><dt>${esc(localized('weeklyBudgetOverfunded', 'Overfunding'))}</dt><dd>${esc(formatCents(activeCalculation?.overfunded_cents, period?.currency))}</dd></div>
    </dl>
    ${pendingLateCandidates > 0 ? `<p class="banking-panel__description">${esc(localized('weeklyBudgetLateCandidates', '{count} late booked transaction(s) are waiting for review.', { count: pendingLateCandidates }))}</p>` : ''}
    <h4>${esc(localized('balances', 'Balances'))}</h4>
    <ul>${balanceRows}</ul>
    <h4>${esc(localized('weeklyBudgetDirectExpenses', 'Direct expenses'))}</h4>
    <ul>${transactionRows}</ul>
    <h4>${esc(localized('weeklyBudgetRevisions', 'Transfer revisions'))}</h4>
    <ul>${revisionRows}</ul>
    <h4>${esc(localized('weeklyBudgetSynchronization', 'Synchronization'))}</h4>
    <ul>${syncRows}</ul>
  `;
}

function weeklyBudgetTransferStateLabel(state) {
  return {
    proposed: localized('weeklyBudgetStatusProposed', 'Proposed'),
    shown: localized('weeklyBudgetStatusShown', 'Shown'),
    notified: localized('weeklyBudgetStatusNotified', 'Notified'),
    source_booked: localized('weeklyBudgetStatusSourceBooked', 'Booked at source'),
    target_booked: localized('weeklyBudgetStatusTargetBooked', 'Arrived at target'),
    target_arrived: localized('weeklyBudgetStatusTargetArrived', 'Transfer completed'),
    completed: localized('weeklyBudgetStatusTargetArrived', 'Transfer completed'),
    zero: localized('weeklyBudgetStatusZero', 'No transfer'),
    no_transfer: localized('weeklyBudgetStatusZero', 'No transfer'),
    dismissed: localized('weeklyBudgetStatusDismissed', 'Dismissed'),
    superseded: localized('weeklyBudgetStatusSuperseded', 'Superseded'),
    failed: localized('failed', 'Failed')
  }[state] ?? String(state || '');
}

async function refreshWeeklyBudget(container, signal, canWrite = container.dataset.bankingPermission === 'write') {
  const host = container.querySelector('[data-weekly-budget-current]');
  const categoriesHost = container.querySelector('[data-weekly-budget-categories]');
  const historyHost = container.querySelector('[data-weekly-budget-history]');
  const [currentResult, accountsResult, categoriesResult, periodsResult, recipientsResult, usersResult] = await Promise.allSettled([
    loadJson('weekly-budget/current', { signal }),
    loadJson('accounts', { signal }),
    loadJson('categories', { signal }),
    loadJson('weekly-budget/periods', { signal }),
    canWrite ? loadJson('push/recipients', { signal }) : Promise.resolve({ data: [] }),
    api.get('/auth/users')
  ]);
  if (signal.aborted) return;
  if (host && currentResult.status === 'fulfilled' && accountsResult.status === 'fulfilled') {
    const accounts = Array.isArray(accountsResult.value?.data) ? accountsResult.value.data : [];
    renderWeeklyBudget(
      host,
      container.querySelector('[data-weekly-budget-settings]'),
      currentResult.value?.data,
      accounts,
      canWrite,
      recipientsResult.status === 'fulfilled' ? recipientsResult.value?.data : [],
      usersResult.status === 'fulfilled' ? usersResult.value?.data : []
    );
  } else if (host) {
    renderError(host, currentResult.status === 'rejected' ? currentResult.reason : accountsResult.reason);
  }
  if (categoriesHost) {
    if (categoriesResult.status === 'fulfilled') {
      renderWeeklyBudgetCategories(categoriesHost, categoriesResult.value?.data, canWrite);
    } else {
      renderError(categoriesHost, categoriesResult.reason);
    }
  }
  if (historyHost) {
    if (periodsResult.status === 'fulfilled') {
      renderWeeklyBudgetHistory(historyHost, periodsResult.value?.data, canWrite);
    } else {
      renderError(historyHost, periodsResult.reason);
    }
  }
}

async function saveWeeklyBudgetSettings({ container, form, signal }) {
  const feedback = form.querySelector('[data-weekly-budget-feedback]');
  const saveButton = form.querySelector('[data-action="save-weekly-budget"]');
  saveButton.disabled = true;
  feedback.textContent = localized('weeklyBudgetSaving', 'Saving weekly-budget settings ...');
  try {
    const targetAmountCents = parseEuroCents(form.querySelector('[data-weekly-amount]').value);
    const sourceAccountId = Number(form.querySelector('[data-weekly-source]').value);
    const targetAccountId = Number(form.querySelector('[data-weekly-target]').value);
    if (!Number.isSafeInteger(sourceAccountId) || !Number.isSafeInteger(targetAccountId)) {
      throw new Error(localized('weeklyBudgetChooseAccounts', 'Choose a source and target account.'));
    }
    const csrf = await loadJson('csrf', { signal });
    await loadJson('weekly-budget/settings', {
      method: 'PUT',
      headers: { 'x-banking-csrf': csrf?.csrf_token ?? '' },
      body: {
        enabled: form.querySelector('[data-weekly-enabled]').checked,
        source_account_id: sourceAccountId,
        target_account_id: targetAccountId,
        target_beneficiary_name: form.querySelector('[data-weekly-beneficiary]').value,
        target_amount_cents: targetAmountCents,
        cutoff_weekday: Number(form.querySelector('[data-weekly-weekday]').value),
        cutoff_time: form.querySelector('[data-weekly-time]').value,
        timezone: form.querySelector('[data-weekly-timezone]').value,
        sync_time_1: form.querySelector('[data-weekly-sync-one]').value,
        sync_time_2: form.querySelector('[data-weekly-sync-two]').value,
        balance_stale_after_minutes: Number(form.dataset.balanceStaleAfterMinutes || 840),
        notification_enabled: form.querySelector('[data-weekly-notifications-enabled]').checked,
        notification_user_id: form.querySelector('[data-weekly-notification-recipient]').value
          ? Number(form.querySelector('[data-weekly-notification-recipient]').value)
          : null,
        notification_qr_preview: form.querySelector('[data-weekly-notification-qr-preview]').checked,
        purpose_prefix: form.dataset.purposePrefix || 'WB'
      },
      signal
    });
    feedback.textContent = localized('weeklyBudgetSaved', 'Weekly-budget settings saved.');
    await refreshWeeklyBudget(container, signal, true);
  } catch (error) {
    if (!signal.aborted) {
      feedback.textContent = error instanceof Error
        ? error.message
        : localized('weeklyBudgetSaveFailed', 'Weekly-budget settings could not be saved.');
    }
  } finally {
    if (!signal.aborted) saveButton.disabled = false;
  }
}

async function updateCategoryWeeklyBudget({ container, checkbox, signal }) {
  const categoryId = checkbox.dataset.weeklyCategoryId;
  if (!/^\d+$/.test(categoryId)) return;
  const previous = checkbox.dataset.currentValue === 'true';
  checkbox.disabled = true;
  try {
    const csrf = await loadJson('csrf', { signal });
    await loadJson(`categories/${encodeURIComponent(categoryId)}/weekly-budget`, {
      method: 'PATCH',
      headers: { 'x-banking-csrf': csrf?.csrf_token ?? '' },
      body: { weekly_budget_default: checkbox.checked },
      signal
    });
    checkbox.dataset.currentValue = String(checkbox.checked);
    await refreshWeeklyBudget(container, signal, true);
  } catch {
    checkbox.checked = previous;
    checkbox.disabled = false;
  }
}

async function updateTransactionWeeklyBudget({ container, select, signal }) {
  const transactionId = select.dataset.transactionId;
  if (!/^\d+$/.test(transactionId)) return;
  const previous = select.dataset.currentValue || 'inherit';
  select.disabled = true;
  try {
    const csrf = await loadJson('csrf', { signal });
    await loadJson(`transactions/${encodeURIComponent(transactionId)}/weekly-budget`, {
      method: 'PATCH',
      headers: { 'x-banking-csrf': csrf?.csrf_token ?? '' },
      body: { weekly_budget_override: select.value },
      signal
    });
    select.dataset.currentValue = select.value;
    await reloadTransactionsAndBudget(container, signal);
  } catch {
    select.value = previous;
  } finally {
    if (!signal.aborted) select.disabled = false;
  }
}

function fillAccountSelect(select, accounts, selectedId, placeholder) {
  select.replaceChildren(createOption('', placeholder));
  if (Array.isArray(accounts)) {
    for (const account of accounts) {
      const id = String(account?.id ?? '');
      if (!/^\d+$/.test(id)) continue;
      const label = `${account?.display_name || localized('unknownAccount', 'Bank account')} · ${account?.iban_masked || ''}`;
      select.append(createOption(id, label));
    }
  }
  select.value = selectedId == null ? '' : String(selectedId);
}

function weekdayOptions() {
  const names = [
    localized('monday', 'Monday'),
    localized('tuesday', 'Tuesday'),
    localized('wednesday', 'Wednesday'),
    localized('thursday', 'Thursday'),
    localized('friday', 'Friday'),
    localized('saturday', 'Saturday'),
    localized('sunday', 'Sunday')
  ];
  return names.map((name, index) => `<option value="${index + 1}">${esc(name)}</option>`).join('');
}

function parseEuroCents(value) {
  const normalized = String(value ?? '').trim().replace(',', '.');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) throw new Error(localized('weeklyBudgetInvalidAmount', 'Enter a valid positive euro amount.'));
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0') || '0');
  const result = Number(cents);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(localized('weeklyBudgetInvalidAmount', 'Enter a valid positive euro amount.'));
  }
  return result;
}

function centsToInput(value) {
  const cents = Number(value);
  if (!Number.isSafeInteger(cents) || cents < 0) return '';
  return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
}

function formatCents(value, currency = 'EUR') {
  const cents = Number(value);
  return Number.isSafeInteger(cents)
    ? formatMoney(cents / 100, currency)
    : localized('unknownAmount', 'Amount unavailable');
}

function formatDateTime(value) {
  if (typeof value !== 'string') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(date);
}

function renderConnections(host, connections) {
  host.replaceChildren();
  if (!Array.isArray(connections) || connections.length === 0) {
    host.insertAdjacentHTML('beforeend', `<p class="banking-muted">${esc(localized('noConnections', 'No bank connection yet.'))}</p>`);
    return;
  }
  for (const connection of connections) {
    const status = typeof connection?.status === 'string' ? connection.status : 'unknown';
    const statusText = {
      authorized: localized('authorized', 'Authorized'),
      pending: localized('pending', 'Pending'),
      failed: localized('failed', 'Failed')
    }[status] ?? localized('unknownStatus', 'Unknown status');
    host.insertAdjacentHTML('beforeend', `
      <article class="banking-connection-row">
        <div>
          <strong>${esc(connection?.aspsp_name || localized('unknownBank', 'Unknown bank'))}</strong>
          <span>${esc(connection?.aspsp_country || '')}</span>
        </div>
        <div class="banking-connection-row__status" data-state="${esc(status)}">
          <strong>${esc(statusText)}</strong>
          <span>${esc(formatDate(connection?.valid_until) || localized('noExpiry', 'No expiry date'))}</span>
        </div>
      </article>
    `);
  }
}

function renderAccounts(host, accounts, canWrite) {
  host.replaceChildren();
  if (!Array.isArray(accounts) || accounts.length === 0) {
    host.insertAdjacentHTML('beforeend', `<p class="banking-muted">${esc(localized('noAccounts', 'No bank accounts available yet.'))}</p>`);
    return;
  }
  for (const account of accounts) {
    const id = String(account?.id ?? '');
    const detailsId = `banking-account-details-${id}`;
    const accountName = account?.display_name || localized('unknownAccount', 'Bank account');
    const accountMeta = [account?.iban_masked || account?.account_type, account?.currency].filter(Boolean).join(' · ');
    host.insertAdjacentHTML('beforeend', `
      <article class="banking-account-card" data-banking-account-card data-account-id="${esc(id)}" data-can-write="${canWrite ? 'true' : 'false'}">
        <div class="banking-account-card__header">
          <div class="banking-account-card__identity">
            <strong class="banking-account-card__name">${esc(accountName)}</strong>
            <span class="banking-account-card__meta">${esc(accountMeta)}</span>
          </div>
          <div class="banking-account-card__actions">
            <button class="btn btn--secondary" type="button" data-action="show-account" data-account-id="${esc(id)}" aria-expanded="false" aria-controls="${esc(detailsId)}">
              ${esc(localized('showAccount', 'Show details'))}
            </button>
            ${canWrite ? `<button class="btn btn--primary" type="button" data-action="sync-account" data-account-id="${esc(id)}">
              ${esc(localized('syncAccount', 'Synchronize'))}
            </button>` : ''}
          </div>
        </div>
        <p class="banking-feedback" data-account-feedback role="status"></p>
        <div id="${esc(detailsId)}" class="banking-account-card__details" data-account-details data-loaded="false" hidden>
          <div>
            <h4>${esc(localized('balances', 'Balances'))}</h4>
            <div data-account-balances><p class="banking-muted">${esc(localized('notLoaded', 'Not loaded yet.'))}</p></div>
          </div>
          ${canWrite ? `<div class="banking-account-card__maintenance"><button class="btn btn--secondary" type="button" data-action="load-merchant-logos" data-account-id="${esc(id)}">${esc(localized('loadMerchantLogos', 'Load merchant logos'))}</button></div>` : ''}
        </div>
      </article>
    `);
  }
}

async function toggleAccountDetails({ card, button, signal }) {
  if (!card) return;
  const accountId = card.dataset.accountId;
  if (!/^\d+$/.test(accountId)) return;
  const feedback = card.querySelector('[data-account-feedback]');
  const balancesHost = card.querySelector('[data-account-balances]');
  const details = card.querySelector('[data-account-details]');

  if (!details.hidden) {
    details.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    button.textContent = localized('showAccount', 'Show details');
    feedback.textContent = '';
    return;
  }

  details.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  button.textContent = localized('hideAccountDetails', 'Hide details');
  if (details.dataset.loaded === 'true') return;

  button.disabled = true;
  card.setAttribute('aria-busy', 'true');
  feedback.textContent = localized('loadingDetails', 'Loading account details ...');
  balancesHost.replaceChildren();
  balancesHost.insertAdjacentHTML('beforeend', `<p class="banking-muted">${esc(localized('loadingDetails', 'Loading account details ...'))}</p>`);
  try {
    const payload = await loadJson(`accounts/${encodeURIComponent(accountId)}/balances`, { signal });
    if (signal.aborted) return;

    renderBalances(balancesHost, payload?.data);
    details.dataset.loaded = 'true';
    feedback.textContent = localized('detailsLoaded', 'Account details loaded.');
  } catch (error) {
    if (!signal.aborted) {
      feedback.textContent = error instanceof Error
        ? error.message
        : localized('detailsFailed', 'Account details could not be loaded.');
      renderError(balancesHost, error);
    }
  } finally {
    if (!signal.aborted) {
      button.disabled = false;
      card.removeAttribute('aria-busy');
    }
  }
}

async function syncAccount({ container, card, button, signal }) {
  if (!container || !card) return;
  const accountId = card.dataset.accountId;
  if (!/^\d+$/.test(accountId)) return;
  const feedback = card.querySelector('[data-account-feedback]');
  const balancesHost = card.querySelector('[data-account-balances]');
  const details = card.querySelector('[data-account-details]');
  const wasOpen = !details.hidden;
  button.disabled = true;
  card.setAttribute('aria-busy', 'true');
  feedback.textContent = localized('syncing', 'Synchronizing ...');
  try {
    const csrf = await loadJson('csrf', { signal });
    const csrfToken = typeof csrf?.csrf_token === 'string' ? csrf.csrf_token : '';
    const syncResult = await loadJson(`accounts/${encodeURIComponent(accountId)}/sync`, {
      method: 'POST',
      headers: { 'x-banking-csrf': csrfToken },
      signal
    });
    if (signal.aborted) return;

    if (wasOpen) {
      try {
        const balancesPayload = await loadJson(`accounts/${encodeURIComponent(accountId)}/balances`, { signal });
        if (signal.aborted) return;
        renderBalances(balancesHost, balancesPayload?.data);
        details.dataset.loaded = 'true';
      } catch (error) {
        if (signal.aborted) return;
        renderError(balancesHost, error);
      }
    }
    const data = syncResult?.data;
    const imported = data?.imported;
    feedback.textContent = imported
      ? localized('syncComplete', 'Sync complete: {inserted} new, {updated} updated.', {
          inserted: imported.inserted ?? 0,
          updated: imported.updated ?? 0
        })
      : localized('syncCompleteShort', 'Sync complete.');
    await reloadTransactionsAndBudget(container, signal);
  } catch (error) {
    if (!signal.aborted) feedback.textContent = error instanceof Error
      ? error.message
      : localized('syncFailed', 'Synchronization failed.');
  } finally {
    if (!signal.aborted) {
      button.disabled = false;
      card.removeAttribute('aria-busy');
    }
  }
}

async function loadMerchantLogos({ container, card, button, signal }) {
  if (!container || !card) return;
  const accountId = card.dataset.accountId;
  if (!/^\d+$/.test(accountId)) return;
  const feedback = card.querySelector('[data-account-feedback]');
  button.disabled = true;
  feedback.textContent = localized('loadingMerchantLogos', 'Loading merchant logos ...');
  try {
    const csrf = await loadJson('csrf', { signal });
    const result = await loadJson(`accounts/${encodeURIComponent(accountId)}/merchant-logos/refresh`, {
      method: 'POST',
      headers: { 'x-banking-csrf': csrf?.csrf_token ?? '' },
      body: {},
      signal
    });
    if (signal.aborted) return;
    if (container.bankingTransactionState) await loadTransactionTable({ container, signal });
    const data = result?.data ?? {};
    feedback.textContent = localized('merchantLogosLoaded', '{cached} loaded, {unavailable} unavailable.', {
      cached: data.cached ?? 0,
      unavailable: data.unavailable ?? 0
    });
  } catch (error) {
    if (!signal.aborted) feedback.textContent = error instanceof Error
      ? error.message
      : localized('merchantLogosFailed', 'Merchant logos could not be loaded.');
  } finally {
    if (!signal.aborted) button.disabled = false;
  }
}

function renderBalances(host, balances) {
  host.replaceChildren();
  if (!Array.isArray(balances) || balances.length === 0) {
    host.insertAdjacentHTML('beforeend', `<p class="banking-muted">${esc(localized('noBalances', 'No balances returned.'))}</p>`);
    return;
  }
  const list = balances.map((balance) => {
    const amount = balance?.balance_amount?.amount ?? balance?.amount;
    const currency = balance?.balance_amount?.currency ?? balance?.currency;
    const label = balance?.balance_type || balance?.type || localized('balance', 'Balance');
    return `<li><span>${esc(String(label))}</span><strong>${esc(formatMoney(amount, currency))}</strong></li>`;
  }).join('');
  host.insertAdjacentHTML('beforeend', `<ul class="banking-balance-list">${list}</ul>`);
}

function renderTransactionFilters(host, accounts, categories, state) {
  const filterHost = host.querySelector('[data-transaction-filters]');
  const accountOptions = (Array.isArray(accounts) ? accounts : []).map((account) => `<option value="${esc(String(account?.id ?? ''))}" ${String(account?.id ?? '') === state.accountId ? 'selected' : ''}>${esc(account?.display_name || localized('unknownAccount', 'Bank account'))}</option>`).join('');
  const categoryOptions = (Array.isArray(categories) ? categories : []).filter((category) => category?.active !== false && /^\d+$/.test(String(category?.id ?? ''))).map((category) => `<option value="${esc(String(category.id))}" ${String(category.id) === state.categoryId ? 'selected' : ''}>${esc(category.name || localized('unknownTransaction', 'Category'))}</option>`).join('');
  filterHost.replaceChildren();
  filterHost.insertAdjacentHTML('beforeend', `
    <form class="banking-transaction-filters" data-transaction-filters>
      <label class="banking-field"><span>${esc(localized('transactionSearch', 'Search'))}</span><input class="form-input" type="search" data-transaction-filter="q" value="${esc(state.q)}" maxlength="200" placeholder="${esc(localized('transactionSearchPlaceholder', 'Merchant, recipient or purpose'))}"></label>
      <label class="banking-field"><span>${esc(localized('transactionAccount', 'Account'))}</span><select class="form-input" data-transaction-filter="accountId"><option value="">${esc(localized('allAccounts', 'All accounts'))}</option>${accountOptions}</select></label>
      <label class="banking-field"><span>${esc(localized('transactionCategoryFilter', 'Category'))}</span><select class="form-input" data-transaction-filter="categoryId"><option value="">${esc(localized('allCategories', 'All categories'))}</option>${categoryOptions}</select></label>
      <label class="banking-field"><span>${esc(localized('transactionDirection', 'Direction'))}</span><select class="form-input" data-transaction-filter="direction"><option value="">${esc(localized('allDirections', 'All'))}</option><option value="incoming" ${state.direction === 'incoming' ? 'selected' : ''}>${esc(localized('incoming', 'Income'))}</option><option value="outgoing" ${state.direction === 'outgoing' ? 'selected' : ''}>${esc(localized('outgoing', 'Expenses'))}</option></select></label>
      <label class="banking-field"><span>${esc(localized('transactionStatus', 'Status'))}</span><select class="form-input" data-transaction-filter="status"><option value="">${esc(localized('allStatuses', 'All statuses'))}</option><option value="BOOK" ${state.status === 'BOOK' ? 'selected' : ''}>${esc(localized('transactionBooked', 'Booked'))}</option><option value="PDNG" ${state.status === 'PDNG' ? 'selected' : ''}>${esc(localized('transactionPending', 'Pending'))}</option><option value="UNKNOWN" ${state.status === 'UNKNOWN' ? 'selected' : ''}>${esc(localized('transactionStatusUnknown', 'Status unknown'))}</option></select></label>
      <label class="banking-field"><span>${esc(localized('dateFrom', 'Date from'))}</span><input class="form-input" type="date" data-transaction-filter="dateFrom" value="${esc(state.dateFrom)}"></label>
      <label class="banking-field"><span>${esc(localized('dateTo', 'Date to'))}</span><input class="form-input" type="date" data-transaction-filter="dateTo" value="${esc(state.dateTo)}"></label>
      <label class="banking-field banking-field--checkbox"><input type="checkbox" data-transaction-filter="uncategorized" ${state.uncategorized ? 'checked' : ''}><span>${esc(localized('uncategorized', 'Without category'))}</span></label>
      <div class="banking-transaction-filters__actions"><button class="btn btn--secondary" type="submit">${esc(localized('applyFilters', 'Apply filters'))}</button><button class="btn btn--secondary" type="button" data-action="reset-transaction-filters">${esc(localized('resetFilters', 'Reset filters'))}</button></div>
    </form>
  `);
}

function updateTransactionFilterState(container, source) {
  const state = container.bankingTransactionState;
  if (!state) return;
  const fields = source.matches?.('[data-transaction-filter]') ? [source] : [...source.querySelectorAll('[data-transaction-filter]')];
  for (const field of fields) {
    const key = field.dataset.transactionFilter;
    state[key] = field.type === 'checkbox' ? field.checked : field.value;
    if (key === 'categoryId' && field.value) state.uncategorized = false;
    if (key === 'uncategorized' && field.checked) state.categoryId = '';
  }
  state.offset = 0;
}

function resetTransactionFilters(container) {
  const state = container.bankingTransactionState;
  Object.assign(state, { q: '', accountId: '', categoryId: '', uncategorized: false, direction: '', status: '', dateFrom: '', dateTo: '', offset: 0 });
  renderTransactionFilters(container.querySelector('[data-banking-transactions]'), container.bankingTransactionAccounts ?? [], container.bankingTransactionCategories ?? [], state);
}

function updateTransactionSort(container, sort) {
  const state = container.bankingTransactionState;
  if (!['date', 'amount', 'merchant', 'account', 'category', 'status'].includes(sort)) return;
  if (state.sort === sort) state.order = state.order === 'asc' ? 'desc' : 'asc';
  else {
    state.sort = sort;
    state.order = 'desc';
  }
  state.offset = 0;
}

async function loadTransactionTable({ container, signal, categories = container.bankingTransactionCategories ?? [] }) {
  const state = container.bankingTransactionState;
  if (!state) return;
  container.bankingTransactionCategories = categories;
  const tableHost = container.querySelector('[data-banking-transactions-table]');
  const paginationHost = container.querySelector('[data-banking-transactions-pagination]');
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;
  const requestId = ++state.requestId;
  signal.addEventListener('abort', () => controller.abort(), { once: true });
  const params = new URLSearchParams({ sort: state.sort, order: state.order, limit: String(state.limit), offset: String(state.offset) });
  for (const [key, value] of [['q', state.q], ['account_id', state.accountId], ['category_id', state.categoryId], ['direction', state.direction], ['status', state.status], ['date_from', state.dateFrom], ['date_to', state.dateTo]]) {
    if (value) params.set(key, value);
  }
  if (state.uncategorized) params.set('uncategorized', '1');
  try {
    const payload = await loadJson(`transactions?${params.toString()}`, { signal: controller.signal });
    if (signal.aborted || requestId !== state.requestId) return;
    renderTransactionTable(tableHost, payload?.data, state, container.dataset.bankingPermission === 'write', categories);
    renderTransactionPagination(paginationHost, payload?.data?.pagination, state);
  } catch (error) {
    if (controller.signal.aborted || signal.aborted || requestId !== state.requestId) return;
    renderError(tableHost, error);
    paginationHost.replaceChildren();
  }
}

function renderTransactionTable(host, payload, state, canWrite, categories) {
  const transactions = Array.isArray(payload?.transactions) ? payload.transactions : [];
  const sortHeader = (key, label) => {
    const active = state.sort === key;
    const ariaSort = active ? (state.order === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th scope="col" aria-sort="${ariaSort}"><button class="banking-transactions-table__sort" type="button" data-transaction-sort="${esc(key)}">${esc(label)}${active ? ` <span aria-hidden="true">${state.order === 'asc' ? '↑' : '↓'}</span>` : ''}</button></th>`;
  };
  const rows = transactions.map((transaction) => {
    const direction = transaction?.direction === 'outgoing' ? 'outgoing' : 'incoming';
    const amount = Number(transaction?.amount);
    const signedAmount = Number.isFinite(amount) ? (direction === 'outgoing' ? -Math.abs(amount) : Math.abs(amount)) : null;
    const title = transaction?.merchant_name || transaction?.counterparty_name || transaction?.purpose || localized('unknownTransaction', 'Transaction');
    const merchantKey = typeof transaction?.merchant_key === 'string' && /^[a-z0-9-]{1,40}$/.test(transaction.merchant_key) ? transaction.merchant_key : '';
    const hasLogo = transaction?.merchant_logo_available === true || Number(transaction?.merchant_logo_available) === 1;
    const mark = merchantKey && hasLogo ? `<img class="banking-merchant-mark" src="${API_PREFIX}/merchant-logos/${encodeURIComponent(merchantKey)}" alt="">` : `<span class="banking-merchant-mark banking-merchant-mark--fallback" aria-hidden="true">${esc(merchantInitials(String(title)))}</span>`;
    const categoryId = String(transaction?.category_id ?? '');
    const transactionId = String(transaction?.id ?? '');
    const categoryOptions = (Array.isArray(categories) ? categories : []).filter((category) => category?.active !== false && /^\d+$/.test(String(category?.id ?? ''))).map((category) => `<option value="${esc(String(category.id))}" ${String(category.id) === categoryId ? 'selected' : ''}>${esc(category.name || localized('unknownTransaction', 'Category'))}</option>`).join('');
    const override = ['inherit', 'include', 'exclude'].includes(transaction?.weekly_budget_override) ? transaction.weekly_budget_override : 'inherit';
    const statusText = { PDNG: localized('transactionPending', 'Pending'), BOOK: localized('transactionBooked', 'Booked'), UNKNOWN: localized('transactionStatusUnknown', 'Status unknown') }[transaction?.status] || localized('transactionStatusUnknown', 'Status unknown');
    const purpose = transaction?.purpose && transaction.purpose !== title ? transaction.purpose : '';
    const accountName = String(transaction?.account_display_name || localized('unknownAccount', 'Bank account'));
    return `<tr>
      <td class="banking-transactions-table__date">${esc(formatDate(transaction?.booking_date || transaction?.value_date || transaction?.transaction_date) || '–')}</td>
      <td><div class="banking-transactions-table__merchant"><strong class="banking-merchant">${mark}<span>${esc(String(title))}</span></strong>${purpose ? `<small>${esc(String(purpose))}</small>` : ''}</div></td>
      <td class="banking-transactions-table__account" title="${esc(accountName)}"><span class="banking-transactions-table__account-name">${esc(accountName)}</span></td>
      <td class="banking-transactions-table__category"><select class="form-input" data-transaction-category-id="${esc(transactionId)}" data-current-category-id="${esc(categoryId)}" ${canWrite && categoryOptions ? '' : 'disabled'}><option value="" ${categoryId ? '' : 'selected'}>${esc(localized('chooseCategory', 'Choose category'))}</option>${categoryOptions}</select></td>
      <td class="banking-transactions-table__weekly-budget"><select class="form-input" data-weekly-budget-override data-transaction-id="${esc(transactionId)}" data-current-value="${esc(override)}" ${canWrite ? '' : 'disabled'}><option value="inherit" ${override === 'inherit' ? 'selected' : ''}>${esc(localized('weeklyBudgetInherit', 'Use category'))}</option><option value="include" ${override === 'include' ? 'selected' : ''}>${esc(localized('weeklyBudgetInclude', 'Include'))}</option><option value="exclude" ${override === 'exclude' ? 'selected' : ''}>${esc(localized('weeklyBudgetExclude', 'Exclude'))}</option></select></td>
      <td class="banking-transactions-table__status">${esc(statusText)}</td>
      <td class="banking-transactions-table__amount banking-transactions-table__amount-column" data-direction="${esc(direction)}">${esc(formatMoney(signedAmount, transaction?.currency))}</td>
    </tr>`;
  }).join('');
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `<table class="banking-transactions-table"><colgroup><col class="banking-transactions-table__date"><col class="banking-transactions-table__merchant-column"><col class="banking-transactions-table__account"><col class="banking-transactions-table__category"><col class="banking-transactions-table__weekly-budget"><col class="banking-transactions-table__status"><col class="banking-transactions-table__amount-column"></colgroup><thead><tr>${sortHeader('date', localized('transactionDate', 'Date'))}${sortHeader('merchant', localized('transactionMerchant', 'Recipient / merchant'))}${sortHeader('account', localized('transactionAccount', 'Account'))}${sortHeader('category', localized('transactionCategory', 'Category'))}<th scope="col">${esc(localized('weeklyBudgetTransaction', 'Weekly budget'))}</th>${sortHeader('status', localized('transactionStatus', 'Status'))}${sortHeader('amount', localized('transactionAmount', 'Amount'))}</tr></thead><tbody>${rows || `<tr><td class="banking-transactions-table__empty" colspan="7">${esc(localized('noTransactionMatches', 'No transactions found.'))}</td></tr>`}</tbody></table>`);
}

function renderTransactionPagination(host, pagination, state) {
  const total = Number(pagination?.total) || 0;
  const from = total === 0 ? 0 : state.offset + 1;
  const to = total === 0 ? 0 : Math.min(state.offset + state.limit, total);
  const hasPrevious = state.offset > 0;
  const hasNext = to < total;
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `<div class="banking-transactions-pagination"><span>${esc(localized('paginationSummary', '{from}–{to} of {total}', { from, to, total }))}</span><div><button class="btn btn--secondary" type="button" data-transaction-page="-1" ${hasPrevious ? '' : 'disabled'}>${esc(localized('previousPage', 'Previous'))}</button><button class="btn btn--secondary" type="button" data-transaction-page="1" ${hasNext ? '' : 'disabled'}>${esc(localized('nextPage', 'Next'))}</button></div></div>`);
}

async function reloadTransactionsAndBudget(container, signal) {
  await Promise.all([
    loadTransactionTable({ container, signal }),
    refreshWeeklyBudget(container, signal, container.dataset.bankingPermission === 'write')
  ]);
}

function renderLegacyTransactions(host, transactions, canWrite = false, categories = []) {
  host.replaceChildren();
  if (!Array.isArray(transactions) || transactions.length === 0) {
    host.insertAdjacentHTML('beforeend', `<p class="banking-muted">${esc(localized('noTransactions', 'No transactions returned.'))}</p>`);
    return;
  }
  const rows = transactions.map((transaction) => {
    const direction = transaction?.direction === 'outgoing' ? 'outgoing' : 'incoming';
    const amount = Number(transaction?.amount);
    const signedAmount = Number.isFinite(amount) ? (direction === 'outgoing' ? -Math.abs(amount) : Math.abs(amount)) : null;
    const currency = transaction?.currency;
    const title = transaction?.merchant_name || transaction?.counterparty_name || transaction?.purpose || localized('unknownTransaction', 'Transaction');
    const merchantKey = typeof transaction?.merchant_key === 'string' && /^[a-z0-9-]{1,40}$/.test(transaction.merchant_key)
      ? transaction.merchant_key
      : '';
    const hasMerchantLogo = transaction?.merchant_logo_available === true || Number(transaction?.merchant_logo_available) === 1;
    const merchantMark = merchantKey && hasMerchantLogo
      ? `<img class="banking-merchant-mark" src="${API_PREFIX}/merchant-logos/${encodeURIComponent(merchantKey)}" alt="">`
      : `<span class="banking-merchant-mark banking-merchant-mark--fallback" aria-hidden="true">${esc(merchantInitials(String(title)))}</span>`;
    const subtitle = transaction?.purpose && transaction.purpose !== title ? transaction.purpose : '';
    const statusText = {
      PDNG: localized('transactionPending', 'Pending'),
      BOOK: localized('transactionBooked', 'Booked'),
      UNKNOWN: localized('transactionStatusUnknown', 'Status unknown')
    }[transaction?.status] || localized('transactionStatusUnknown', 'Status unknown');
    const transactionDate = transaction?.booking_date || transaction?.value_date || transaction?.transaction_date;
    const transactionId = String(transaction?.id ?? '');
    const override = ['inherit', 'include', 'exclude'].includes(transaction?.weekly_budget_override)
      ? transaction.weekly_budget_override
      : 'inherit';
    const categoryId = String(transaction?.category_id ?? '');
    const categoryOptions = Array.isArray(categories)
      ? categories.filter((category) => category?.active !== false && /^\d+$/.test(String(category?.id ?? '')))
      : [];
    return `
      <li class="banking-transaction-row">
        <div>
          <strong class="banking-merchant">${merchantMark}<span>${esc(String(title))}</span></strong>
          <span>${esc(formatDate(transactionDate) || '')}${subtitle ? ` · ${esc(String(subtitle))}` : ''} · ${esc(statusText)}</span>
          ${/^\d+$/.test(transactionId) ? `<label class="banking-transaction-budget">
            <span>${esc(localized('transactionCategory', 'Category'))}</span>
            <select class="form-input" data-transaction-category-id="${esc(transactionId)}" data-current-category-id="${esc(categoryId)}" ${canWrite && categoryOptions.length > 0 ? '' : 'disabled'}>
              <option value="" ${categoryId ? '' : 'selected'} disabled>${esc(localized('chooseCategory', 'Choose category'))}</option>
              ${categoryOptions.map((category) => `<option value="${esc(String(category.id))}" ${String(category.id) === categoryId ? 'selected' : ''}>${esc(category.name || localized('unknownTransaction', 'Category'))}</option>`).join('')}
            </select>
          </label>
          <label class="banking-transaction-budget">
            <span>${esc(localized('weeklyBudgetTransaction', 'Weekly budget'))}</span>
            <select class="form-input" data-weekly-budget-override data-transaction-id="${esc(transactionId)}" data-current-value="${esc(override)}" ${canWrite ? '' : 'disabled'}>
              <option value="inherit" ${override === 'inherit' ? 'selected' : ''}>${esc(localized('weeklyBudgetInherit', 'Use category'))}</option>
              <option value="include" ${override === 'include' ? 'selected' : ''}>${esc(localized('weeklyBudgetInclude', 'Include'))}</option>
              <option value="exclude" ${override === 'exclude' ? 'selected' : ''}>${esc(localized('weeklyBudgetExclude', 'Exclude'))}</option>
            </select>
          </label>` : ''}
        </div>
        <strong class="banking-transaction-row__amount" data-direction="${esc(direction)}">${esc(formatMoney(signedAmount, currency))}</strong>
      </li>
    `;
  }).join('');
  host.insertAdjacentHTML('beforeend', `<ul class="banking-transaction-list">${rows}</ul>`);
}

function merchantInitials(value) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const initials = words.slice(0, 2).map((word) => [...word][0]).join('');
  return initials.toUpperCase().slice(0, 2) || '?';
}

async function updateTransactionCategory({ container, select, signal }) {
  const transactionId = select.dataset.transactionCategoryId;
  const categoryId = Number(select.value);
  if (!/^\d+$/.test(transactionId || '') || !Number.isSafeInteger(categoryId) || categoryId < 1) return;
  const previous = select.dataset.currentCategoryId || '';
  const host = select.closest('[data-banking-transactions]');
  const feedback = host?.querySelector('[data-transactions-feedback]');
  select.disabled = true;
  try {
    const csrf = await loadJson('csrf', { signal });
    const result = await loadJson(`transactions/${encodeURIComponent(transactionId)}/category`, {
      method: 'PATCH',
      headers: { 'x-banking-csrf': csrf?.csrf_token ?? '' },
      body: { category_id: categoryId, remember_counterparty: true },
      signal
    });
    select.dataset.currentCategoryId = String(categoryId);
    await reloadTransactionsAndBudget(container, signal);
    await refreshCategorizationReviews(container, signal);
    if (feedback && !signal.aborted) {
      feedback.textContent = result?.data?.counterparty_rule_created
        ? localized('categoryRuleSaved', 'Category saved for this recipient and future transactions.')
        : localized('categorySaved', 'Category saved.');
    }
  } catch (error) {
    if (!signal.aborted) {
      select.value = previous;
      if (feedback) feedback.textContent = error instanceof Error
        ? error.message
        : localized('categorySaveFailed', 'Category could not be saved.');
    }
  } finally {
    if (!signal.aborted) select.disabled = false;
  }
}

function renderError(host, error) {
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `<p class="banking-error">${esc(error instanceof Error ? error.message : localized('errors.request', 'Banking request failed'))}</p>`);
}

function createOption(value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
}

function formatDate(value) {
  if (typeof value !== 'string') return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'short' }).format(date);
}

function formatMoney(value, currency) {
  if (value === null || value === undefined || value === '') {
    return localized('unknownAmount', 'Amount unavailable');
  }
  const amount = typeof value === 'number' ? value : Number(value);
  const code = typeof currency === 'string' && /^[A-Z]{3}$/i.test(currency) ? currency.toUpperCase() : '';
  if (!Number.isFinite(amount)) return localized('unknownAmount', 'Amount unavailable');
  if (!code) return amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${code}`;
  }
}

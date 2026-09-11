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
    let detail = '';
    try {
      const payload = await response.clone().json();
      detail = typeof payload?.error === 'string' ? payload.error : '';
    } catch {
      // Some proxy errors do not return JSON.
    }
    const error = new Error(detail || `${localized('errors.request', 'Banking request failed')} (HTTP ${response.status})`);
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
            <p class="banking-panel__description">${esc(localized('weeklyBudgetDescription', 'Direct expenses paid from the main account and the current budget-account balance determine the next top-up.'))}</p>
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

      <section class="banking-panel banking-provider-settings" data-enable-banking-settings>
        <div class="banking-panel__header"><div><h2>${esc(localized('enableBankingSettingsTitle', 'Enable Banking configuration'))}</h2><p class="banking-panel__description">${esc(localized('enableBankingSettingsDescription', 'Configure the provider credentials securely in the Banking database. Existing values are kept when secret fields remain empty.'))}</p></div></div>
        <form class="banking-provider-settings__form" data-enable-banking-settings-form>
          <label class="banking-field"><span>${esc(localized('enableBankingEnvironment', 'Environment'))}</span><select class="form-input" data-enable-banking-environment><option value="sandbox">${esc(localized('enableBankingSandbox', 'Sandbox'))}</option><option value="production">${esc(localized('enableBankingProduction', 'Production'))}</option></select></label>
          <label class="banking-field"><span>${esc(localized('enableBankingApiUrl', 'API URL'))}</span><input class="form-input" type="url" autocomplete="url" data-enable-banking-api-url placeholder="api.enablebanking.com"></label>
          <label class="banking-field"><span>${esc(localized('enableBankingApplicationId', 'Application ID'))}</span><input class="form-input" type="text" autocomplete="off" data-enable-banking-application-id placeholder="${esc(localized('enableBankingApplicationIdPlaceholder', 'Enable Banking application ID'))}"></label>
          <label class="banking-field"><span>${esc(localized('enableBankingApiKey', 'API key'))}</span><input class="form-input" type="password" autocomplete="new-password" data-enable-banking-api-key placeholder="${esc(localized('enableBankingSecretPlaceholder', 'Enter a new value; leave blank to keep the current value'))}"></label>
          <label class="banking-field"><span>${esc(localized('enableBankingPrivateKey', 'Private key (.pem)'))}</span><input class="form-input" type="file" accept=".pem,.key,application/x-pem-file,text/plain" data-enable-banking-private-key></label>
          <p class="banking-muted" data-enable-banking-status role="status"></p>
          <p class="banking-muted">${esc(localized('enableBankingPrivateKeyHint', 'The private key is read in the browser only for upload and is encrypted before it is stored on the server. It is never shown again.'))}</p>
          <div class="banking-provider-settings__actions"><button class="btn btn--primary" type="submit" data-action="save-enable-banking-settings">${esc(localized('enableBankingSave', 'Save Enable Banking settings'))}</button></div>
          <p class="banking-feedback" data-enable-banking-settings-feedback role="status"></p>
        </form>
      </section>

      <section class="banking-panel banking-openai-settings" data-banking-openai-settings>
        <div class="banking-panel__header"><div><h2>${esc(localized('openAiSettingsTitle', 'OpenAI configuration'))}</h2><p class="banking-panel__description">${esc(localized('openAiSettingsDescription', 'Store the API key securely and choose the model used for transaction analysis.'))}</p></div></div>
        <form class="banking-openai-settings__form" data-openai-settings-form>
          <label class="banking-field"><span>${esc(localized('openAiApiKey', 'OpenAI API key'))}</span><input class="form-input" type="password" autocomplete="new-password" data-openai-api-key placeholder="${esc(localized('openAiApiKeyPlaceholder', 'Enter a new key; leave blank to keep the current key'))}"></label>
          <label class="banking-field"><span>${esc(localized('openAiModel', 'Model'))}</span><select class="form-input" data-openai-model><option value="">${esc(localized('openAiChooseModel', 'Choose a model'))}</option></select></label>
          <p class="banking-muted" data-openai-api-key-status role="status"></p>
          <p class="banking-muted" data-openai-models-feedback role="status"></p>
          <div class="banking-openai-settings__actions"><button class="btn btn--secondary" type="button" data-action="load-openai-models">${esc(localized('openAiLoadModels', 'Load available models'))}</button><button class="btn btn--primary" type="submit" data-action="save-openai-settings">${esc(localized('openAiSave', 'Save OpenAI settings'))}</button></div>
          <p class="banking-feedback" data-openai-settings-feedback role="status"></p>
        </form>
      </section>

      <section class="banking-panel" data-banking-weekly-budget>
        <div class="banking-panel__header"><div><h2>${esc(localized('weeklyBudgetConfigureTitle', 'Configure weekly budget'))}</h2><p class="banking-panel__description">${esc(localized('weeklyBudgetDescription', 'Direct expenses paid from the main account and the current budget-account balance determine the next top-up.'))}</p></div></div>
        <div data-weekly-budget-current aria-live="polite"><p class="banking-muted">${esc(localized('loading', 'Loading ...'))}</p></div>
        ${weeklyBudgetSettingsMarkup()}
      </section>

      <section class="banking-panel banking-push" data-banking-push aria-live="polite">
        <div class="banking-panel__header"><div><h2>${esc(localized('pushTitle', 'Banking notifications'))}</h2><p class="banking-panel__description">${esc(localized('pushDescription', 'Enable notifications explicitly on this device.'))}</p></div><div class="banking-weekly-settings__actions"><button class="btn btn--secondary" type="button" data-action="enable-banking-push">${esc(localized('pushEnable', 'Enable on this device'))}</button><button class="btn btn--secondary" type="button" data-action="test-banking-push">${esc(localized('pushTest', 'Send test'))}</button></div></div>
        <p class="banking-feedback" data-banking-push-feedback role="status"></p><div data-banking-push-subscriptions></div>
      </section>

      <section class="banking-panel banking-category-management" id="banking-categories" data-banking-category-management>
        <div class="banking-category-management__header"><div><h2>${esc(localized('categoriesTitle', 'Categories'))}</h2><p class="banking-panel__description">${esc(localized('categoriesDescription', 'Manage categories for transactions, rules and the weekly budget.'))}</p></div><button class="btn btn--primary" type="button" data-action="add-category">${esc(localized('categoryAdd', 'Add category'))}</button></div>
        <p class="banking-feedback" data-category-feedback role="status"></p><div data-banking-categories></div>
      </section>
      <dialog class="banking-category-dialog" data-banking-category-dialog aria-labelledby="banking-category-dialog-title">
        <form class="banking-category-dialog__form" data-banking-category-form method="dialog">
          <div class="banking-transaction-dialog__header"><h2 id="banking-category-dialog-title"></h2><button class="btn btn--secondary" type="button" data-action="close-category-dialog">${esc(localized('categoryCancel', 'Cancel'))}</button></div>
          <div class="banking-transaction-dialog__body"><label class="banking-field"><span>${esc(localized('categoryName', 'Name'))}</span><input class="form-input" type="text" maxlength="80" required data-category-name></label><label class="banking-field"><span>${esc(localized('categoryType', 'Type'))}</span><select class="form-input" data-category-type><option value="expense">${esc(localized('categoryTypeExpense', 'Expense'))}</option><option value="income">${esc(localized('categoryTypeIncome', 'Income'))}</option><option value="transfer">${esc(localized('categoryTypeTransfer', 'Transfer'))}</option></select></label><label class="banking-field banking-field--checkbox"><input type="checkbox" data-category-weekly-budget><span>${esc(localized('categoryWeeklyBudgetDefault', 'Include in weekly budget by default'))}</span></label><p class="banking-muted" data-category-weekly-budget-hint hidden>${esc(localized('categoryWeeklyBudgetExpenseOnly', 'Only expense categories can be included in the weekly budget.'))}</p><div class="banking-category-dialog__actions"><button class="btn btn--secondary" type="button" data-action="close-category-dialog">${esc(localized('categoryCancel', 'Cancel'))}</button><button class="btn btn--primary" type="submit" data-action="save-category"></button></div><p class="banking-feedback" data-category-dialog-feedback role="status"></p></div>
        </form>
      </dialog>
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
        <div class="banking-transactions-toolbar">
          <span class="banking-transactions-count" data-transactions-count>0</span>
          <div class="banking-transactions-toolbar__actions">
            <details class="banking-transaction-columns" data-transaction-columns-menu>
              <summary class="btn btn--secondary">${esc(localized('transactionColumns', 'Columns'))}</summary>
              <div class="banking-transaction-columns__menu" data-transaction-columns-options></div>
            </details>
            <button class="btn btn--secondary banking-transaction-filter-toggle" type="button" data-action="toggle-transaction-filters">${esc(localized('transactionFilters', 'Filters'))}<span data-transaction-filter-count></span></button>
          </div>
        </div>
        <div data-transaction-filters></div>
        <p class="banking-feedback" data-transactions-feedback role="status"></p>
        <div class="banking-transactions-table-wrap" data-banking-transactions-table><p class="banking-muted">${esc(localized('loading', 'Loading ...'))}</p></div>
        <div data-banking-transactions-pagination></div>
        <dialog class="banking-transaction-dialog" data-banking-transaction-dialog aria-labelledby="banking-transaction-dialog-title">
          <div class="banking-transaction-dialog__header"><h2 id="banking-transaction-dialog-title">${esc(localized('transactionDetails', 'Transaction details'))}</h2><button class="btn btn--secondary" type="button" data-action="close-transaction-details">${esc(localized('transactionDetailsClose', 'Close'))}</button></div>
          <div class="banking-transaction-dialog__body" data-banking-transaction-dialog-content></div>
        </dialog>
      </div>
    </details>
  `;
}

function configureMainInteractions(container, permission, signal) {
  const canWrite = permission === 'write';
  const reloadWeeklyBudget = container.querySelector('[data-action="reload-weekly-budget"]');
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
    const column = event.target.closest('[data-transaction-column-toggle]');
    if (column) {
      const key = column.dataset.transactionColumnToggle;
      if (key in container.bankingTransactionState.columns) {
        container.bankingTransactionState.columns[key] = column.checked;
        persistTransactionColumns(container.bankingTransactionState.columns);
        renderTransactionFilters(transactionsHost, container.bankingTransactionAccounts ?? [], container.bankingTransactionCategories ?? [], container.bankingTransactionState);
        void loadTransactionTable({ container, signal });
      }
      return;
    }
    const pageSize = event.target.closest('[data-transaction-page-size]');
    if (pageSize) {
      const limit = Number(pageSize.value);
      if ([10, 25, 50, 100].includes(limit)) {
        container.bankingTransactionState.limit = limit;
        container.bankingTransactionState.offset = 0;
        void loadTransactionTable({ container, signal });
      }
      return;
    }
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
    if (event.target.closest('[data-action="toggle-transaction-filters"]')) {
      const state = container.bankingTransactionState;
      state.filtersOpen = !state.filtersOpen;
      persistTransactionFilterPanel(state.filtersOpen);
      renderTransactionFilters(transactionsHost, container.bankingTransactionAccounts ?? [], container.bankingTransactionCategories ?? [], state);
      return;
    }
    if (event.target.closest('[data-action="close-transaction-details"]')) {
      container.querySelector('[data-banking-transaction-dialog]')?.close();
      return;
    }
    const detailButton = event.target.closest('[data-action="transaction-details"]');
    if (detailButton) {
      void openTransactionDetail({ container, transactionId: detailButton.dataset.transactionId, signal });
      return;
    }
    const enrichButton = event.target.closest('[data-action="enrich-transaction"]');
    if (enrichButton) {
      void enrichTransactionDetail({ container, transactionId: enrichButton.dataset.transactionId, signal });
      return;
    }
    const sortButton = event.target.closest('[data-transaction-sort]');
    if (sortButton) {
      updateTransactionSort(container, sortButton.dataset.transactionSort);
      void loadTransactionTable({ container, signal });
      return;
    }
    const pageButton = event.target.closest('[data-transaction-page]');
    if (pageButton && !pageButton.disabled) {
      const state = container.bankingTransactionState;
      const page = Number(pageButton.dataset.transactionPage);
      state.offset = page < 1
        ? Math.max(0, state.offset + page * state.limit)
        : Math.max(0, (page - 1) * state.limit);
      void loadTransactionTable({ container, signal });
      return;
    }
    if (event.target.closest('[data-action="reset-transaction-filters"]')) {
      resetTransactionFilters(container);
      void loadTransactionTable({ container, signal });
    }
    const row = event.target.closest('[data-transaction-row]');
    if (row && !event.target.closest('select,input,button,a,label')) {
      void openTransactionDetail({ container, transactionId: row.dataset.transactionId, signal });
    }
  }, { signal });
  transactionsHost.addEventListener('keydown', (event) => {
    const row = event.target.closest('[data-transaction-row]');
    if (row && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      void openTransactionDetail({ container, transactionId: row.dataset.transactionId, signal });
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

async function enrichTransactionDetail({ container, transactionId, signal }) {
  if (!/^\d+$/.test(transactionId || '')) return;
  try {
    const csrf = await loadJson('csrf', { signal });
    await loadJson(`transactions/${encodeURIComponent(transactionId)}/enrich`, {
      method: 'POST', body: {}, signal, headers: { 'x-banking-csrf': csrf?.csrf_token ?? '' }
    });
    if (!signal.aborted) {
      await openTransactionDetail({ container, transactionId, signal });
      await loadTransactionTable({ container, signal });
    }
  } catch (error) {
    if (!signal.aborted) renderError(
      container.querySelector('[data-banking-transaction-dialog-content]'), error
    );
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
  const categoryManagement = container.querySelector('[data-banking-category-management]');
  const categoryDialog = container.querySelector('[data-banking-category-dialog]');
  const providerForm = container.querySelector('[data-enable-banking-settings-form]');
  const providerEnvironment = container.querySelector('[data-enable-banking-environment]');
  const providerApiUrl = container.querySelector('[data-enable-banking-api-url]');
  const providerApplicationId = container.querySelector('[data-enable-banking-application-id]');
  const providerApiKey = container.querySelector('[data-enable-banking-api-key]');
  const providerPrivateKey = container.querySelector('[data-enable-banking-private-key]');
  const providerSaveButton = container.querySelector('[data-action="save-enable-banking-settings"]');
  const openAiForm = container.querySelector('[data-openai-settings-form]');
  const openAiApiKey = container.querySelector('[data-openai-api-key]');
  const openAiModel = container.querySelector('[data-openai-model]');
  const openAiLoadModelsButton = container.querySelector('[data-action="load-openai-models"]');
  const openAiSaveButton = container.querySelector('[data-action="save-openai-settings"]');
  const pushHost = container.querySelector('[data-banking-push]');
  const enablePushButton = container.querySelector('[data-action="enable-banking-push"]');
  const testPushButton = container.querySelector('[data-action="test-banking-push"]');
  const aspspsByName = new Map();

  if (!canWrite) {
    feedback.textContent = localized('readOnly', 'Your Banking permission is read-only.');
    for (const control of [country, bank, loadButton, connectButton, providerEnvironment, providerApiUrl, providerApplicationId, providerApiKey, providerPrivateKey, providerSaveButton, openAiApiKey, openAiModel, openAiLoadModelsButton, openAiSaveButton, enablePushButton, testPushButton]) {
      control.disabled = true;
    }
    categoryManagement?.querySelector('[data-action="add-category"]')?.setAttribute('disabled', '');
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
  providerForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveEnableBankingSettings({ container, form: providerForm, signal });
  }, { signal });
  weeklySettings.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveWeeklyBudgetSettings({ container, form: weeklySettings, signal });
  }, { signal });
  if (categoryManagement) categoryManagement.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || !canWrite) return;
    if (button.dataset.action === 'add-category') openCreateCategoryDialog(container);
    if (button.dataset.action === 'edit-category') openEditCategoryDialog(container, categoryById(container, button.dataset.categoryId));
    if (button.dataset.action === 'deactivate-category') void setCategoryActive(container, button.dataset.categoryId, false, signal);
    if (button.dataset.action === 'reactivate-category') void setCategoryActive(container, button.dataset.categoryId, true, signal);
  }, { signal });
  if (categoryDialog) {
    categoryDialog.addEventListener('click', (event) => {
      if (event.target.closest('[data-action="close-category-dialog"]')) categoryDialog.close();
    }, { signal });
    categoryDialog.addEventListener('change', (event) => {
      if (event.target.closest('[data-category-type]')) configureCategoryDialog(categoryDialog);
    }, { signal });
    categoryDialog.querySelector('[data-banking-category-form]')?.addEventListener('submit', (event) => {
      event.preventDefault();
      void saveCategory(container, categoryDialog, signal);
    }, { signal });
  }
  openAiForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveOpenAiSettings({ container, form: openAiForm, signal });
  }, { signal });
  openAiLoadModelsButton.addEventListener('click', () => {
    void loadOpenAiModels({ container, signal });
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
  const historyHost = container.querySelector('[data-weekly-budget-history]');
  const categorizationHost = container.querySelector('[data-banking-categorization]');
  const runCategorizationButton = container.querySelector('[data-action="run-categorization"]');
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
  const hasActiveCategories = categories.some((category) => category?.active !== false);
  if (canWrite && runCategorizationButton && categoriesResult.status === 'fulfilled' && !hasActiveCategories) {
    const categorizationFeedback = container.querySelector('[data-categorization-feedback]');
    if (categorizationFeedback) categorizationFeedback.textContent = localized(
      'categorizationNoCategoriesHint',
      'No categories yet. Create categories in settings or use the analysis to get suggestions.'
    );
  }
  const weeklyBudget = weeklyBudgetResult.status === 'fulfilled' ? weeklyBudgetResult.value?.data : null;
  const weeklyBudgetSettings = weeklyBudget?.configured === true ? weeklyBudget.settings : null;
  if (accountsResult.status === 'fulfilled') renderAccounts(accountsHost, accounts, canWrite, weeklyBudgetSettings);
  else renderError(accountsHost, accountsResult.reason);
  if (weeklyBudgetResult.status === 'fulfilled') renderWeeklyBudget(weeklyBudgetHost, null, weeklyBudget, accounts, canWrite);
  else renderError(weeklyBudgetHost, weeklyBudgetResult.reason);
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
  const categoriesHost = container.querySelector('[data-banking-categories]');
  const providerHost = container.querySelector('[data-enable-banking-settings]');
  const openAiHost = container.querySelector('[data-banking-openai-settings]');
  const [connectionsResult, accountsResult, weeklyBudgetResult, categoriesResult, recipientsResult, usersResult, providerResult, openAiResult, openAiModelsResult] = await Promise.allSettled([
    loadJson('connections', { signal }),
    loadJson('accounts', { signal }),
    loadJson('weekly-budget/current', { signal }),
    loadJson('categories', { signal }),
    loadJson('push/recipients', { signal }),
    api.get('/auth/users'),
    loadJson('enablebanking/settings', { signal }),
    loadJson('openai/settings', { signal }),
    loadJson('openai/models', { signal })
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
  if (categoriesResult.status === 'fulfilled') {
    container.bankingTransactionCategories = categoriesResult.value?.data ?? [];
    renderCategoryManagement(categoriesHost, container.bankingTransactionCategories, canWrite);
  }
  else renderError(categoriesHost, categoriesResult.reason);
  if (providerResult.status === 'fulfilled') renderEnableBankingSettings(providerHost, providerResult.value?.data, canWrite);
  else renderEnableBankingSettingsError(providerHost, providerResult.reason, canWrite);
  if (openAiResult.status === 'fulfilled') renderOpenAiSettings(
    openAiHost,
    openAiResult.value?.data,
    openAiModelsResult.status === 'fulfilled' ? openAiModelsResult.value?.data : null,
    canWrite
  );
  else renderOpenAiSettingsError(openAiHost, openAiResult.reason, canWrite);
  await loadBankingPushPanel(container, signal, canWrite);
}

function renderEnableBankingSettings(host, settings, canWrite) {
  if (!host) return;
  const form = host.querySelector('[data-enable-banking-settings-form]');
  const environment = host.querySelector('[data-enable-banking-environment]');
  const apiUrl = host.querySelector('[data-enable-banking-api-url]');
  const applicationId = host.querySelector('[data-enable-banking-application-id]');
  const apiKey = host.querySelector('[data-enable-banking-api-key]');
  const privateKey = host.querySelector('[data-enable-banking-private-key]');
  const status = host.querySelector('[data-enable-banking-status]');
  const saveButton = host.querySelector('[data-action="save-enable-banking-settings"]');
  if (!form || !environment || !apiUrl || !applicationId || !apiKey || !privateKey || !status || !saveButton) return;

  environment.value = settings?.environment === 'production' ? 'production' : 'sandbox';
  apiUrl.value = typeof settings?.api_url === 'string' ? settings.api_url : '';
  applicationId.value = '';
  apiKey.value = '';
  privateKey.value = '';
  form.dataset.applicationIdConfigured = settings?.application_id_configured === true ? 'true' : 'false';
  form.dataset.apiKeyConfigured = settings?.api_key_configured === true ? 'true' : 'false';
  form.dataset.privateKeyConfigured = settings?.private_key_configured === true ? 'true' : 'false';
  status.textContent = [
    `${localized('enableBankingApplicationId', 'Application ID')}: ${settings?.application_id_configured === true ? localized('configured', 'configured') : localized('notConfigured', 'not configured')}`,
    `${localized('enableBankingApiKey', 'API key')}: ${settings?.api_key_configured === true ? localized('configured', 'configured') : localized('notConfigured', 'not configured')}`,
    `${localized('enableBankingPrivateKey', 'Private key')}: ${settings?.private_key_configured === true ? localized('configured', 'configured') : localized('notConfigured', 'not configured')}`
  ].join(' · ');
  for (const control of [environment, apiUrl, applicationId, apiKey, privateKey]) control.disabled = !canWrite;
  saveButton.disabled = !canWrite;
  if (!canWrite) {
    const feedback = host.querySelector('[data-enable-banking-settings-feedback]');
    if (feedback) feedback.textContent = localized('readOnly', 'Your Banking permission is read-only.');
  }
}

function renderEnableBankingSettingsError(host, error, canWrite) {
  if (!host) return;
  const feedback = host.querySelector('[data-enable-banking-settings-feedback]');
  if (feedback) feedback.textContent = error instanceof Error
    ? error.message
    : localized('enableBankingLoadFailed', 'Enable Banking settings could not be loaded.');
  const form = host.querySelector('[data-enable-banking-settings-form]');
  if (form && !canWrite) {
    for (const control of form.querySelectorAll('input, select, button')) control.disabled = true;
  }
}

async function saveEnableBankingSettings({ container, form, signal }) {
  const feedback = form.querySelector('[data-enable-banking-settings-feedback]');
  const saveButton = form.querySelector('[data-action="save-enable-banking-settings"]');
  const environment = form.querySelector('[data-enable-banking-environment]');
  const apiUrl = form.querySelector('[data-enable-banking-api-url]');
  const applicationId = form.querySelector('[data-enable-banking-application-id]');
  const apiKey = form.querySelector('[data-enable-banking-api-key]');
  const privateKey = form.querySelector('[data-enable-banking-private-key]');
  saveButton.disabled = true;
  feedback.textContent = localized('enableBankingSaving', 'Saving Enable Banking settings ...');
  try {
    const body = {
      environment: environment.value,
      api_url: apiUrl.value.trim()
    };
    if (applicationId.value.trim()) body.application_id = applicationId.value.trim();
    if (apiKey.value.trim()) body.api_key = apiKey.value.trim();
    if (privateKey.files?.[0]) body.private_key = await privateKey.files[0].text();
    const csrf = await loadJson('csrf', { signal });
    const result = await loadJson('enablebanking/settings', {
      method: 'PUT',
      headers: { 'x-banking-csrf': csrf?.csrf_token ?? '' },
      body,
      signal
    });
    renderEnableBankingSettings(container.querySelector('[data-enable-banking-settings]'), result?.data, true);
    feedback.textContent = localized('enableBankingSaved', 'Enable Banking settings saved.');
  } catch (error) {
    if (!signal.aborted) feedback.textContent = error instanceof Error
      ? error.message
      : localized('enableBankingSaveFailed', 'Enable Banking settings could not be saved.');
  } finally {
    if (!signal.aborted) saveButton.disabled = false;
  }
}

function renderOpenAiSettings(host, settings, modelsPayload, canWrite) {
  if (!host) return;
  const form = host.querySelector('[data-openai-settings-form]');
  const apiKey = host.querySelector('[data-openai-api-key]');
  const model = host.querySelector('[data-openai-model]');
  const status = host.querySelector('[data-openai-api-key-status]');
  const modelsFeedback = host.querySelector('[data-openai-models-feedback]');
  const loadModelsButton = host.querySelector('[data-action="load-openai-models"]');
  const saveButton = host.querySelector('[data-action="save-openai-settings"]');
  if (!form || !apiKey || !model || !status || !modelsFeedback || !loadModelsButton || !saveButton) return;

  const selectedModel = typeof settings?.model === 'string' ? settings.model : '';
  renderOpenAiModelOptions(model, selectedModel, modelsPayload?.models);
  apiKey.value = '';
  form.dataset.apiKeyConfigured = settings?.api_key_configured === true ? 'true' : 'false';
  status.textContent = settings?.api_key_configured === true
    ? localized('openAiApiKeyConfigured', 'An OpenAI API key is stored securely.')
    : localized('openAiApiKeyNotConfigured', 'No OpenAI API key has been stored yet.');
  apiKey.disabled = !canWrite;
  model.disabled = !canWrite || model.options.length <= 1;
  loadModelsButton.disabled = !canWrite || form.dataset.apiKeyConfigured !== 'true';
  saveButton.disabled = !canWrite;
  modelsFeedback.textContent = modelsPayload?.error
    ? modelsPayload.error
    : modelsPayload?.models?.length
      ? localized('openAiModelsLoaded', '{count} models available from OpenAI.', { count: modelsPayload.models.length })
      : settings?.api_key_configured === true
        ? localized('openAiNoModels', 'No compatible OpenAI models were returned.')
        : '';
  if (!canWrite) {
    const feedback = host.querySelector('[data-openai-settings-feedback]');
    if (feedback) feedback.textContent = localized('readOnly', 'Your Banking permission is read-only.');
  }
}

function renderOpenAiModelOptions(select, selectedModel, models) {
  select.replaceChildren(createOption('', localized('openAiChooseModel', 'Choose a model')));
  const modelOptions = Array.isArray(models) ? models : [];
  const ids = new Set();
  for (const option of modelOptions) {
    if (typeof option?.id !== 'string' || !option.id || ids.has(option.id)) continue;
    ids.add(option.id);
    select.appendChild(createOption(option.id, typeof option.label === 'string' ? option.label : option.id));
  }
  if (selectedModel && !ids.has(selectedModel)) {
    select.appendChild(createOption(selectedModel, `${selectedModel} (${localized('openAiCurrentModel', 'current')})`));
  }
  select.value = selectedModel;
}

async function loadOpenAiModels({ container, signal }) {
  const host = container.querySelector('[data-banking-openai-settings]');
  const button = host?.querySelector('[data-action="load-openai-models"]');
  const feedback = host?.querySelector('[data-openai-models-feedback]');
  if (!host || !button || !feedback) return;
  button.disabled = true;
  feedback.textContent = localized('openAiLoadingModels', 'Loading available models from OpenAI ...');
  try {
    const result = await loadJson('openai/models', { signal });
    const settingsResult = await loadJson('openai/settings', { signal });
    if (signal.aborted) return;
    renderOpenAiSettings(host, settingsResult?.data, result?.data, true);
  } catch (error) {
    if (!signal.aborted) feedback.textContent = error instanceof Error
      ? error.message
      : localized('openAiModelsFailed', 'OpenAI models could not be loaded.');
  } finally {
    if (!signal.aborted) button.disabled = false;
  }
}

function renderOpenAiSettingsError(host, error, canWrite) {
  if (!host) return;
  const feedback = host.querySelector('[data-openai-settings-feedback]');
  if (feedback) feedback.textContent = error instanceof Error
    ? error.message
    : localized('openAiLoadFailed', 'OpenAI settings could not be loaded.');
  const form = host.querySelector('[data-openai-settings-form]');
  if (form && !canWrite) {
    for (const control of form.querySelectorAll('input, select, button')) control.disabled = true;
  }
}

async function saveOpenAiSettings({ container, form, signal }) {
  const feedback = form.querySelector('[data-openai-settings-feedback]');
  const saveButton = form.querySelector('[data-action="save-openai-settings"]');
  const apiKey = form.querySelector('[data-openai-api-key]');
  const model = form.querySelector('[data-openai-model]');
  saveButton.disabled = true;
  feedback.textContent = localized('openAiSaving', 'Saving OpenAI settings ...');
  try {
    const key = apiKey.value.trim();
    if (!key && form.dataset.apiKeyConfigured !== 'true') {
      throw new Error(localized('openAiApiKeyRequired', 'Enter an OpenAI API key first.'));
    }
    const csrf = await loadJson('csrf', { signal });
    const body = {};
    if (key) body.api_key = key;
    if (model.value) body.model = model.value;
    if (!Object.keys(body).length) throw new Error(localized('openAiApiKeyRequired', 'Enter an OpenAI API key first.'));
    const result = await loadJson('openai/settings', {
      method: 'PUT',
      headers: { 'x-banking-csrf': csrf?.csrf_token ?? '' },
      body,
      signal
    });
    const models = await loadJson('openai/models', { signal });
    renderOpenAiSettings(container.querySelector('[data-banking-openai-settings]'), result?.data, models?.data, true);
    feedback.textContent = localized('openAiSaved', 'OpenAI settings saved.');
  } catch (error) {
    if (!signal.aborted) feedback.textContent = error instanceof Error
      ? error.message
      : localized('openAiSaveFailed', 'OpenAI settings could not be saved.');
  } finally {
    if (!signal.aborted) saveButton.disabled = false;
  }
}

function createTransactionState() {
  return {
    q: '', accountId: '', categoryId: '', uncategorized: false, direction: '', status: '', dateFrom: '', dateTo: '',
    sort: 'date', order: 'desc', limit: 25, offset: 0, requestId: 0, controller: null,
    filtersOpen: readTransactionFilterPanel(), columns: readTransactionColumns()
  };
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
    if (action === 'accept-category-suggestion') await refreshCategoryDependentViews(container, signal);
    await refreshCategorizationReviews(container, signal);
    const suggestions = await loadJson('category-suggestions', { signal });
    if (!signal.aborted) renderCategorySuggestions(host, suggestions?.data, true);
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
          localized('weeklyBudgetAvailable', 'Available in budget account'),
          formatCents(current?.available_to_spend_cents, settings?.currency),
          summaryMeta(
            settings?.target_account?.display_name,
            balance?.stale ? localized('weeklyBudgetStale', 'Balance is stale') : formatDateTime(balance?.fetched_at)
          )
        )}
        ${weeklySummaryCard(
          localized('weeklyBudgetDirect', 'Direct expenses from main account'),
          formatCents(current?.direct_expense_cents, settings?.currency),
          summaryMeta(
            settings?.source_account?.display_name,
            localized('weeklyBudgetDirectCount', '{count} included transactions', {
              count: Array.isArray(current?.direct_expenses) ? current.direct_expenses.length : 0
            })
          )
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

function summaryMeta(accountName, detail) {
  return [accountName, detail]
    .filter((value) => typeof value === 'string' && value.trim())
    .join(' · ');
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

function categoryTypeLabel(type) {
  return type === 'income' ? localized('categoryTypeIncome', 'Income')
    : type === 'transfer' ? localized('categoryTypeTransfer', 'Transfer')
      : localized('categoryTypeExpense', 'Expense');
}

function categoryById(container, id) {
  return (container.bankingTransactionCategories ?? []).find((category) => String(category?.id) === String(id)) ?? null;
}

function renderCategoryManagement(host, categories, canWrite) {
  if (!host) return;
  host.replaceChildren();
  if (!Array.isArray(categories) || categories.length === 0) {
    host.insertAdjacentHTML('beforeend', `
      <p class="banking-muted">${esc(localized('categoriesEmpty', 'No categories have been created yet.'))}</p>
      <p class="banking-panel__description">${esc(localized('categoriesEmptyHint', 'Create a category or use transaction analysis to receive suggestions.'))}</p>
    `);
    return;
  }
  const row = (category, inactive = false) => `<div class="banking-category-row${inactive ? ' is-inactive' : ''}">
    <div class="banking-category-row__identity"><strong>${esc(category?.name || localized('unknownTransaction', 'Category'))}</strong><span class="banking-category-row__meta"><span class="banking-category-type">${esc(categoryTypeLabel(category?.type))}</span>${category?.type === 'expense' ? `<span>${esc(category?.weekly_budget_default ? localized('categoryWeeklyBudgetEnabled', 'Weekly budget') : localized('categoryWeeklyBudgetDisabled', 'Not in weekly budget'))}</span>` : ''}</span></div>
    <div class="banking-category-row__actions">${!inactive ? `<button class="btn btn--secondary" type="button" data-action="edit-category" data-category-id="${esc(String(category?.id ?? ''))}" ${canWrite ? '' : 'disabled'}>${esc(localized('categoryEdit', 'Edit'))}</button><button class="btn btn--secondary" type="button" data-action="deactivate-category" data-category-id="${esc(String(category?.id ?? ''))}" ${canWrite ? '' : 'disabled'}>${esc(localized('categoryDeactivate', 'Deactivate'))}</button>` : `<button class="btn btn--secondary" type="button" data-action="reactivate-category" data-category-id="${esc(String(category?.id ?? ''))}" ${canWrite ? '' : 'disabled'}>${esc(localized('categoryReactivate', 'Reactivate'))}</button>`}</div>
  </div>`;
  const active = categories.filter((category) => category?.active !== false);
  const inactive = categories.filter((category) => category?.active === false);
  host.insertAdjacentHTML('beforeend', `<div class="banking-category-list">${active.map((category) => row(category)).join('')}</div>${inactive.length ? `<details class="banking-category-inactive"><summary>${esc(localized('inactiveCategories', 'Inactive categories ({count})', { count: inactive.length }))}</summary><div class="banking-category-list">${inactive.map((category) => row(category, true)).join('')}</div></details>` : ''}`);
}

function openCreateCategoryDialog(container) {
  const dialog = container.querySelector('[data-banking-category-dialog]');
  if (!dialog) return;
  dialog.dataset.categoryId = '';
  dialog.querySelector('#banking-category-dialog-title').textContent = localized('categoryAdd', 'Add category');
  dialog.querySelector('[data-category-name]').value = '';
  dialog.querySelector('[data-category-type]').value = 'expense';
  dialog.querySelector('[data-category-type]').disabled = false;
  dialog.querySelector('[data-category-weekly-budget]').checked = false;
  dialog.querySelector('[data-category-dialog-feedback]').textContent = '';
  dialog.querySelector('[data-action="save-category"]').textContent = localized('categoryCreate', 'Create category');
  configureCategoryDialog(dialog);
  if (!dialog.open && typeof dialog.showModal === 'function') dialog.showModal();
  dialog.querySelector('[data-category-name]')?.focus();
}

function openEditCategoryDialog(container, category) {
  if (!category) return;
  const dialog = container.querySelector('[data-banking-category-dialog]');
  if (!dialog) return;
  dialog.dataset.categoryId = String(category.id);
  dialog.querySelector('#banking-category-dialog-title').textContent = localized('categoryEdit', 'Edit category');
  dialog.querySelector('[data-category-name]').value = category.name || '';
  dialog.querySelector('[data-category-type]').value = category.type || 'expense';
  dialog.querySelector('[data-category-type]').disabled = true;
  dialog.querySelector('[data-category-weekly-budget]').checked = category.weekly_budget_default === true;
  dialog.querySelector('[data-category-dialog-feedback]').textContent = '';
  dialog.querySelector('[data-action="save-category"]').textContent = localized('categorySave', 'Save category');
  configureCategoryDialog(dialog);
  if (!dialog.open && typeof dialog.showModal === 'function') dialog.showModal();
  dialog.querySelector('[data-category-name]')?.focus();
}

function configureCategoryDialog(dialog) {
  const type = dialog.querySelector('[data-category-type]')?.value;
  const weekly = dialog.querySelector('[data-category-weekly-budget]');
  const hint = dialog.querySelector('[data-category-weekly-budget-hint]');
  const enabled = type === 'expense';
  if (weekly) { weekly.disabled = !enabled; if (!enabled) weekly.checked = false; }
  if (hint) hint.hidden = enabled;
}

async function saveCategory(container, dialog, signal) {
  const id = dialog.dataset.categoryId;
  const name = dialog.querySelector('[data-category-name]');
  const type = dialog.querySelector('[data-category-type]');
  const weekly = dialog.querySelector('[data-category-weekly-budget]');
  const feedback = dialog.querySelector('[data-category-dialog-feedback]');
  const saveButton = dialog.querySelector('[data-action="save-category"]');
  if (!name || !type || !weekly || !saveButton) return;
  saveButton.disabled = true;
  try {
    const csrf = await loadJson('csrf', { signal });
    const body = id ? { name: name.value, weekly_budget_default: weekly.checked } : { name: name.value, type: type.value, weekly_budget_default: weekly.checked };
    await loadJson(id ? `categories/${encodeURIComponent(id)}` : 'categories', { method: id ? 'PATCH' : 'POST', headers: { 'x-banking-csrf': csrf?.csrf_token ?? '' }, body, signal });
    if (signal.aborted) return;
    dialog.close();
    await refreshCategoryDependentViews(container, signal);
    const target = container.querySelector('[data-category-feedback]');
    if (target) target.textContent = localized(id ? 'categoryUpdated' : 'categoryCreated', id ? 'Category updated.' : 'Category created.');
  } catch (error) {
    if (!signal.aborted && feedback) feedback.textContent = error instanceof Error ? error.message : localized('categoryInvalid', 'Category is invalid.');
  } finally { if (!signal.aborted) saveButton.disabled = false; }
}

async function setCategoryActive(container, id, active, signal) {
  if (!/^\d+$/.test(id || '')) return;
  if (!active && !window.confirm(localized('categoryDeactivateConfirm', 'Deactivate this category? Historical transactions will keep their assignment.'))) return;
  try {
    const csrf = await loadJson('csrf', { signal });
    await loadJson(`categories/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'x-banking-csrf': csrf?.csrf_token ?? '' }, body: { active }, signal });
    if (signal.aborted) return;
    await refreshCategoryDependentViews(container, signal);
    const feedback = container.querySelector('[data-category-feedback]');
    if (feedback) feedback.textContent = localized(active ? 'categoryReactivated' : 'categoryDeactivated', active ? 'Category reactivated.' : 'Category deactivated.');
  } catch (error) {
    const feedback = container.querySelector('[data-category-feedback]');
    if (!signal.aborted && feedback) feedback.textContent = error instanceof Error ? error.message : localized('categoryInvalid', 'Category is invalid.');
  }
}

async function refreshCategoryDependentViews(container, signal) {
  const result = await loadJson('categories', { signal });
  if (signal.aborted) return;
  const categories = Array.isArray(result?.data) ? result.data : [];
  container.bankingTransactionCategories = categories;
  const categoryHost = container.querySelector('[data-banking-categories]');
  if (categoryHost) renderCategoryManagement(categoryHost, categories, container.dataset.bankingPermission === 'write');
  const transactions = container.querySelector('[data-banking-transactions]');
  if (transactions && container.bankingTransactionState) {
    renderTransactionFilters(transactions, container.bankingTransactionAccounts ?? [], categories, container.bankingTransactionState);
    await loadTransactionTable({ container, signal, categories });
  }
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
  const categoriesHost = container.querySelector('[data-banking-categories]');
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
      container.bankingTransactionCategories = categoriesResult.value?.data ?? [];
      renderCategoryManagement(categoriesHost, container.bankingTransactionCategories, canWrite);
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

function renderAccounts(host, accounts, canWrite, settings = null) {
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
    const accountRole = settings && Number(account?.id) === Number(settings.source_account?.id)
      ? localized('accountRoleMain', 'Main account')
      : settings && Number(account?.id) === Number(settings.target_account?.id)
        ? localized('accountRoleBudget', 'Budget account')
        : '';
    host.insertAdjacentHTML('beforeend', `
      <article class="banking-account-card" data-banking-account-card data-account-id="${esc(id)}" data-can-write="${canWrite ? 'true' : 'false'}">
        <div class="banking-account-card__header">
          <div class="banking-account-card__identity">
            <strong class="banking-account-card__name">${esc(accountName)}${accountRole ? ` <span class="banking-account-card__role">${esc(accountRole)}</span>` : ''}</strong>
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
  const categoryList = (Array.isArray(categories) ? categories : []).filter((category) => /^\d+$/.test(String(category?.id ?? '')));
  const filterGroup = (items) => items.map((category) => `<option value="${esc(String(category.id))}" ${String(category.id) === state.categoryId ? 'selected' : ''}>${esc(category.name || localized('unknownTransaction', 'Category'))}</option>`).join('');
  const activeCategories = categoryList.filter((category) => category?.active !== false);
  const inactiveCategories = categoryList.filter((category) => category?.active === false);
  const categoryOptions = `${activeCategories.length ? `<optgroup label="${esc(localized('categoryActive', 'Active'))}">${filterGroup(activeCategories)}</optgroup>` : ''}${inactiveCategories.length ? `<optgroup label="${esc(localized('categoryInactive', 'Inactive'))}">${filterGroup(inactiveCategories)}</optgroup>` : ''}`;
  const activeCount = countActiveTransactionFilters(state);
  const filterButtonCount = host.querySelector('[data-transaction-filter-count]');
  if (filterButtonCount) {
    filterButtonCount.textContent = activeCount ? String(activeCount) : '';
    filterButtonCount.hidden = activeCount === 0;
  }
  const columnsHost = host.querySelector('[data-transaction-columns-options]');
  if (columnsHost) {
    columnsHost.replaceChildren();
    columnsHost.insertAdjacentHTML('beforeend', ['account', 'category', 'weeklyBudget', 'status'].map((key) => `
      <label><input type="checkbox" data-transaction-column-toggle="${key}" ${state.columns[key] ? 'checked' : ''}>${esc(localized(`transactionColumns${key[0].toUpperCase()}${key.slice(1)}`, key))}</label>
    `).join(''));
  }
  filterHost.replaceChildren();
  filterHost.insertAdjacentHTML('beforeend', `
    <form class="banking-transaction-filter-panel" data-transaction-filters data-transaction-filter-panel ${state.filtersOpen ? '' : 'hidden'}>
      <div class="banking-transaction-filter-row">
        <label><span class="banking-sr-only">${esc(localized('transactionSearch', 'Search'))}</span><input class="form-input" type="search" data-transaction-filter="q" value="${esc(state.q)}" maxlength="200" placeholder="${esc(localized('transactionSearchPlaceholder', 'Merchant, recipient or purpose'))}"></label>
        <label><span class="banking-sr-only">${esc(localized('transactionAccount', 'Account'))}</span><select class="form-input" data-transaction-filter="accountId"><option value="">${esc(localized('allAccounts', 'All accounts'))}</option>${accountOptions}</select></label>
        <label><span class="banking-sr-only">${esc(localized('transactionCategoryFilter', 'Category'))}</span><select class="form-input" data-transaction-filter="categoryId"><option value="">${esc(localized('allCategories', 'All categories'))}</option>${categoryOptions}</select></label>
        <span class="banking-transaction-date-range"><label><span class="banking-sr-only">${esc(localized('dateFrom', 'Date from'))}</span><input class="form-input" type="date" data-transaction-filter="dateFrom" value="${esc(state.dateFrom)}"></label><span aria-hidden="true">–</span><label><span class="banking-sr-only">${esc(localized('dateTo', 'Date to'))}</span><input class="form-input" type="date" data-transaction-filter="dateTo" value="${esc(state.dateTo)}"></label></span>
        <label><span class="banking-sr-only">${esc(localized('transactionDirection', 'Direction'))}</span><select class="form-input" data-transaction-filter="direction"><option value="">${esc(localized('allDirections', 'All'))}</option><option value="incoming" ${state.direction === 'incoming' ? 'selected' : ''}>${esc(localized('incoming', 'Income'))}</option><option value="outgoing" ${state.direction === 'outgoing' ? 'selected' : ''}>${esc(localized('outgoing', 'Expenses'))}</option></select></label>
      </div>
      <div class="banking-transaction-filter-row banking-transaction-filter-row--secondary">
        <label class="banking-field--checkbox"><input type="checkbox" data-transaction-filter="uncategorized" ${state.uncategorized ? 'checked' : ''}><span>${esc(localized('uncategorized', 'Without category'))}</span></label>
        <details><summary>${esc(localized('transactionMoreFilters', 'More filters'))}</summary><label><span class="banking-sr-only">${esc(localized('transactionStatus', 'Status'))}</span><select class="form-input" data-transaction-filter="status"><option value="">${esc(localized('allStatuses', 'All statuses'))}</option><option value="BOOK" ${state.status === 'BOOK' ? 'selected' : ''}>${esc(localized('transactionBooked', 'Booked'))}</option><option value="PDNG" ${state.status === 'PDNG' ? 'selected' : ''}>${esc(localized('transactionPending', 'Pending'))}</option><option value="UNKNOWN" ${state.status === 'UNKNOWN' ? 'selected' : ''}>${esc(localized('transactionStatusUnknown', 'Status unknown'))}</option></select></label></details>
        <button class="btn btn--secondary" type="button" data-action="reset-transaction-filters">${esc(localized('resetFilters', 'Reset filters'))}</button>
      </div>
    </form>
  `);
}

function countActiveTransactionFilters(state) {
  return Number(Boolean(state.q)) + Number(Boolean(state.accountId))
    + Number(Boolean(state.categoryId) || Boolean(state.uncategorized))
    + Number(Boolean(state.direction)) + Number(Boolean(state.status))
    + Number(Boolean(state.dateFrom) || Boolean(state.dateTo));
}

function readTransactionFilterPanel() {
  try { return sessionStorage.getItem('yuvomi:banking:transaction-filters-open') !== 'false'; } catch { return true; }
}

function persistTransactionFilterPanel(open) {
  try { sessionStorage.setItem('yuvomi:banking:transaction-filters-open', String(open)); } catch { /* storage is optional */ }
}

function readTransactionColumns() {
  const defaults = { account: true, category: true, weeklyBudget: true, status: true };
  try {
    const parsed = JSON.parse(sessionStorage.getItem('yuvomi:banking:transaction-columns') || '');
    return Object.fromEntries(Object.keys(defaults).map((key) => [key, typeof parsed?.[key] === 'boolean' ? parsed[key] : defaults[key]]));
  } catch { return defaults; }
}

function persistTransactionColumns(columns) {
  try { sessionStorage.setItem('yuvomi:banking:transaction-columns', JSON.stringify(columns)); } catch { /* storage is optional */ }
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
    renderTransactionTable(tableHost, payload?.data, state, container.dataset.bankingPermission === 'write', categories, container.bankingTransactionAccounts ?? []);
    renderTransactionPagination(paginationHost, payload?.data?.pagination, state);
    const count = container.querySelector('[data-transactions-count]');
    if (count) count.textContent = String(Number(payload?.data?.pagination?.total) || 0);
  } catch (error) {
    if (controller.signal.aborted || signal.aborted || requestId !== state.requestId) return;
    renderError(tableHost, error);
    paginationHost.replaceChildren();
  }
}

function renderTransactionTable(host, payload, state, canWrite, categories, accounts) {
  const transactions = Array.isArray(payload?.transactions) ? payload.transactions : [];
  const sortHeader = (key, label) => {
    const active = state.sort === key;
    const ariaSort = active ? (state.order === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th scope="col" aria-sort="${ariaSort}"><button class="banking-transactions-table__sort" type="button" data-transaction-sort="${esc(key)}">${esc(label)}${active ? ` <span aria-hidden="true">${state.order === 'asc' ? '↑' : '↓'}</span>` : ''}</button></th>`;
  };
  const optionalColumn = (key) => state.columns[key] ? '' : ' hidden';
  const optionalSortHeader = (key, label, column) => sortHeader(key, label)
    .replace('<th ', `<th data-transaction-column="${column}"${optionalColumn(column)} `);
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
    const categoryOptions = transactionCategoryOptions(categories, categoryId);
    const override = ['inherit', 'include', 'exclude'].includes(transaction?.weekly_budget_override) ? transaction.weekly_budget_override : 'inherit';
    const statusText = { PDNG: localized('transactionPending', 'Pending'), BOOK: localized('transactionBooked', 'Booked'), UNKNOWN: localized('transactionStatusUnknown', 'Status unknown') }[transaction?.status] || localized('transactionStatusUnknown', 'Status unknown');
    const purpose = transaction?.purpose && transaction.purpose !== title ? transaction.purpose : '';
    const account = (Array.isArray(accounts) ? accounts : []).find((item) => String(item?.id) === String(transaction?.account_id));
    const accountName = String(account?.display_name || transaction?.account_display_name || localized('unknownAccount', 'Bank account'));
    const accountIban = typeof account?.iban_masked === 'string' ? account.iban_masked : '';
    const statusClass = transaction?.status === 'BOOK' ? 'booked' : transaction?.status === 'PDNG' ? 'pending' : 'unknown';
    return `<tr class="banking-transactions-table__row" data-transaction-row data-transaction-id="${esc(transactionId)}" tabindex="0">
      <td class="banking-transactions-table__date">${esc(formatDate(transaction?.booking_date || transaction?.value_date || transaction?.transaction_date) || '–')}</td>
      <td><div class="banking-transactions-table__merchant"><strong class="banking-merchant">${mark}<span>${esc(String(title))}</span></strong>${purpose ? `<small>${esc(String(purpose))}</small>` : ''}</div></td>
      <td class="banking-transactions-table__account" data-transaction-column="account"${optionalColumn('account')} title="${esc(accountName)}"><span class="banking-transactions-table__account-name">${esc(accountName)}</span>${accountIban ? `<small>${esc(accountIban)}</small>` : ''}</td>
      <td class="banking-transactions-table__category" data-transaction-column="category"${optionalColumn('category')}><select class="banking-table-select" data-transaction-category-id="${esc(transactionId)}" data-current-category-id="${esc(categoryId)}" ${canWrite && hasActiveTransactionCategories(categories) ? '' : 'disabled'}><option value="" ${categoryId ? '' : 'selected'}>${esc(localized('chooseCategory', 'Choose category'))}</option>${categoryOptions}</select></td>
      <td class="banking-transactions-table__weekly-budget" data-transaction-column="weeklyBudget"${optionalColumn('weeklyBudget')}><select class="banking-table-select" data-weekly-budget-override data-transaction-id="${esc(transactionId)}" data-current-value="${esc(override)}" ${canWrite ? '' : 'disabled'}><option value="inherit" ${override === 'inherit' ? 'selected' : ''}>${esc(localized('weeklyBudgetInherit', 'Use category'))}</option><option value="include" ${override === 'include' ? 'selected' : ''}>${esc(localized('weeklyBudgetInclude', 'Include'))}</option><option value="exclude" ${override === 'exclude' ? 'selected' : ''}>${esc(localized('weeklyBudgetExclude', 'Exclude'))}</option></select></td>
      <td class="banking-transactions-table__status" data-transaction-column="status"${optionalColumn('status')}><span class="banking-transaction-status banking-transaction-status--${statusClass}">${esc(statusText)}</span></td>
      <td class="banking-transactions-table__amount banking-transactions-table__amount-column" data-direction="${esc(direction)}">${esc(formatTransactionAmount(transaction))}</td>
      <td class="banking-transactions-table__action"><button class="btn btn--secondary" type="button" data-action="transaction-details" data-transaction-id="${esc(transactionId)}" aria-label="${esc(localized('transactionDetailsOpen', 'Show transaction details'))}">⋮</button></td>
    </tr>`;
  }).join('');
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `<table class="banking-transactions-table"><colgroup><col class="banking-transactions-table__date"><col class="banking-transactions-table__merchant-column"><col class="banking-transactions-table__account" data-transaction-column="account"${optionalColumn('account')}><col class="banking-transactions-table__category" data-transaction-column="category"${optionalColumn('category')}><col class="banking-transactions-table__weekly-budget" data-transaction-column="weeklyBudget"${optionalColumn('weeklyBudget')}><col class="banking-transactions-table__status" data-transaction-column="status"${optionalColumn('status')}><col class="banking-transactions-table__amount-column"><col class="banking-transactions-table__action"></colgroup><thead><tr>${sortHeader('date', localized('transactionDate', 'Date'))}${sortHeader('merchant', localized('transactionMerchant', 'Recipient / merchant'))}${optionalSortHeader('account', localized('transactionAccount', 'Account'), 'account')}${optionalSortHeader('category', localized('transactionCategory', 'Category'), 'category')}<th data-transaction-column="weeklyBudget"${optionalColumn('weeklyBudget')}>${esc(localized('weeklyBudgetTransaction', 'Weekly budget'))}</th>${optionalSortHeader('status', localized('transactionStatus', 'Status'), 'status')}${sortHeader('amount', localized('transactionAmount', 'Amount'))}<th aria-label="${esc(localized('transactionDetails', 'Transaction details'))}"></th></tr></thead><tbody>${rows || `<tr><td class="banking-transactions-table__empty" colspan="8">${esc(localized('noTransactionMatches', 'No transactions found.'))}</td></tr>`}</tbody></table>`);
}

function renderTransactionPagination(host, pagination, state) {
  const total = Number(pagination?.total) || 0;
  const from = total === 0 ? 0 : state.offset + 1;
  const to = total === 0 ? 0 : Math.min(state.offset + state.limit, total);
  const hasPrevious = state.offset > 0;
  const hasNext = to < total;
  const pageCount = Math.max(1, Math.ceil(total / state.limit));
  const currentPage = Math.floor(state.offset / state.limit) + 1;
  const pages = new Set([1, pageCount]);
  for (let page = Math.max(1, currentPage - 2); page <= Math.min(pageCount, currentPage + 2); page += 1) pages.add(page);
  const pageButtons = [...pages].sort((left, right) => left - right).flatMap((page, index, list) => {
    const gap = index > 0 && page - list[index - 1] > 1 ? ['<span aria-hidden="true">…</span>'] : [];
    return [...gap, `<button class="btn btn--secondary" type="button" data-transaction-page="${page}" ${page === currentPage ? 'aria-current="page" disabled' : ''}>${page}</button>`];
  }).join('');
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `<div class="banking-transactions-pagination__pages">${pageButtons}</div><label class="banking-transactions-pagination__page-size"><span class="banking-sr-only">${esc(localized('transactionsPerPage', 'Transactions per page'))}</span><select class="banking-table-select" data-transaction-page-size>${[10, 25, 50, 100].map((limit) => `<option value="${limit}" ${limit === state.limit ? 'selected' : ''}>${limit}</option>`).join('')}</select></label>`);
  host.insertAdjacentHTML('beforeend', `<div class="banking-transactions-pagination"><span>${esc(localized('paginationSummary', '{from}–{to} of {total}', { from, to, total }))}</span><div><button class="btn btn--secondary" type="button" data-transaction-page="-1" ${hasPrevious ? '' : 'disabled'}>${esc(localized('previousPage', 'Previous'))}</button><button class="btn btn--secondary" type="button" data-transaction-page="1" ${hasNext ? '' : 'disabled'}>${esc(localized('nextPage', 'Next'))}</button></div></div>`);
}

async function reloadTransactionsAndBudget(container, signal) {
  await Promise.all([
    loadTransactionTable({ container, signal }),
    refreshWeeklyBudget(container, signal, container.dataset.bankingPermission === 'write')
  ]);
}

function formatTransactionAmount(transaction) {
  const amount = Number(transaction?.amount);
  if (!Number.isFinite(amount)) return localized('unknownAmount', 'Amount unavailable');
  const signed = transaction?.direction === 'outgoing' ? -Math.abs(amount) : Math.abs(amount);
  return `${signed >= 0 ? '+' : ''}${formatMoney(signed, transaction?.currency)}`;
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
    const categoryOptions = transactionCategoryOptions(categories, categoryId);
    return `
      <li class="banking-transaction-row">
        <div>
          <strong class="banking-merchant">${merchantMark}<span>${esc(String(title))}</span></strong>
          <span>${esc(formatDate(transactionDate) || '')}${subtitle ? ` · ${esc(String(subtitle))}` : ''} · ${esc(statusText)}</span>
          ${/^\d+$/.test(transactionId) ? `<label class="banking-transaction-budget">
            <span>${esc(localized('transactionCategory', 'Category'))}</span>
            <select class="form-input" data-transaction-category-id="${esc(transactionId)}" data-current-category-id="${esc(categoryId)}" ${canWrite && hasActiveTransactionCategories(categories) ? '' : 'disabled'}>
              <option value="" ${categoryId ? '' : 'selected'} disabled>${esc(localized('chooseCategory', 'Choose category'))}</option>
              ${categoryOptions}
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

function transactionCategoryOptions(categories, currentCategoryId) {
  const categoryList = (Array.isArray(categories) ? categories : []).filter((category) => /^\d+$/.test(String(category?.id ?? '')));
  const active = categoryList.filter((category) => category?.active !== false).map((category) => `<option value="${esc(String(category.id))}" ${String(category.id) === String(currentCategoryId) ? 'selected' : ''}>${esc(category.name || localized('unknownTransaction', 'Category'))}</option>`).join('');
  const currentInactive = categoryList.find((category) => category?.active === false && String(category.id) === String(currentCategoryId));
  return `${currentInactive ? `<option value="${esc(String(currentInactive.id))}" selected disabled>${esc(`${currentInactive.name || localized('unknownTransaction', 'Category')} (${localized('categoryInactive', 'inactive')})`)}</option>` : ''}${active}`;
}

function hasActiveTransactionCategories(categories) {
  return Array.isArray(categories) && categories.some((category) => category?.active !== false && /^\d+$/.test(String(category?.id ?? '')));
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

async function openTransactionDetail({ container, transactionId, signal }) {
  if (!/^\d+$/.test(transactionId || '')) return;
  const dialog = container.querySelector('[data-banking-transaction-dialog]');
  const content = container.querySelector('[data-banking-transaction-dialog-content]');
  if (!dialog || !content) return;
  content.replaceChildren();
  content.insertAdjacentHTML('beforeend', `<p class="banking-muted">${esc(localized('loading', 'Loading ...'))}</p>`);
  if (!dialog.open && typeof dialog.showModal === 'function') dialog.showModal();
  try {
    const payload = await loadJson(`transactions/${encodeURIComponent(transactionId)}`, { signal });
    if (signal.aborted) return;
    renderTransactionDetail(content, payload?.data);
  } catch (error) {
    if (!signal.aborted) {
      content.replaceChildren();
      content.insertAdjacentHTML('beforeend', `<p class="banking-error">${esc(error instanceof Error ? error.message : localized('transactionDetailLoadFailed', 'Transaction details could not be loaded.'))}</p>`);
    }
  }
}

function renderTransactionDetail(host, detail) {
  const transaction = detail?.transaction ?? {};
  const counterparty = detail?.counterparty ?? null;
  const account = detail?.account ?? {};
  const bank = detail?.bank ?? {};
  const title = transaction.merchant_name || transaction.counterparty_name || transaction.purpose || localized('unknownTransaction', 'Transaction');
  const date = formatDate(transaction.booking_date || transaction.value_date || transaction.transaction_date) || '–';
  const status = { BOOK: localized('transactionBooked', 'Booked'), PDNG: localized('transactionPending', 'Pending'), UNKNOWN: localized('transactionStatusUnknown', 'Status unknown') }[transaction.status] || localized('transactionStatusUnknown', 'Status unknown');
  const value = (item) => item === null || item === undefined || item === '' ? '–' : String(item);
  const section = (heading, fields) => `<section class="banking-transaction-detail-section"><h3>${esc(heading)}</h3><dl class="banking-transaction-detail-grid">${fields.map(([label, item]) => `<div><dt>${esc(label)}</dt><dd>${esc(value(item))}</dd></div>`).join('')}</dl></section>`;
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `
    <div class="banking-transaction-dialog__header"><div><strong>${esc(String(title))}</strong><small>${esc(`${date} · ${status}`)}</small></div><strong class="banking-transactions-table__amount" data-direction="${esc(transaction.direction === 'outgoing' ? 'outgoing' : 'incoming')}">${esc(formatTransactionAmount(transaction))}</strong></div>
    ${section(localized('transactionDetailsBooking', 'Booking'), [
      [localized('transactionAmount', 'Amount'), formatTransactionAmount(transaction)], ['Währung', transaction.currency], [localized('transactionDirection', 'Direction'), transaction.direction], [localized('transactionStatus', 'Status'), status], [localized('transactionDate', 'Booking date'), transaction.booking_date], ['Valutadatum', transaction.value_date], ['Transaktionsdatum', transaction.transaction_date], ['Verwendungszweck', transaction.purpose]
    ])}
    ${section(localized('transactionDetailsCounterparty', 'Recipient / counterparty'), [
      ['Name', transaction.counterparty_name], ['IBAN', counterparty?.iban], ['Merchant-Name', transaction.merchant_name], ['Merchant-Key', transaction.merchant_key], ['MCC', transaction.mcc], ['Counterparty-ID', counterparty?.counterparty_id], ['Normalisierter Händler', counterparty?.normalized_merchant_name]
    ])}
    ${section(localized('transactionDetailsAccount', 'Own account / bank'), [
      [localized('transactionAccount', 'Account'), account.display_name], ['IBAN', account.iban], ['Kontotyp', account.account_type], ['Währung', account.currency], ['Provider-Konto-ID', account.provider_account_id], ['Bank / ASPSP', bank.aspsp_name], ['Land', bank.aspsp_country]
    ])}
    ${section(localized('transactionDetailsCategorization', 'Categorization / weekly budget'), [
      [localized('transactionCategory', 'Category'), transaction.category_name], ['Kategorie-ID', transaction.category_id], ['Quelle', transaction.category_source], ['Confidence', transaction.category_confidence], [localized('weeklyBudgetTransaction', 'Weekly budget'), transaction.weekly_budget_override], ['Kategorie-Standard', transaction.category_weekly_budget_default], ['Yuvomi-Budget-Entry-ID', transaction.yuvomi_budget_entry_id]
    ])}
    ${section(localized('transactionDetailsProviderRefs', 'Bank / provider references'), [
      ['Provider transaction key', transaction.provider_transaction_id], ['entry_reference', transaction.entry_reference], ['transaction_id', transaction.transaction_id], ['Note', transaction.provider_note], ['Referenznummer', transaction.reference_number]
    ])}
    ${section(localized('transactionEnrichment', 'Provider enrichment'), [
      [localized('transactionDetailState', 'Detail status'), detail?.enrichment?.provider_detail_state],
      [localized('transactionEvidenceSource', 'Merchant evidence'), detail?.enrichment?.merchant_evidence_source],
      [localized('transactionResolutionMethod', 'Recognition'), detail?.enrichment?.merchant_resolution_method],
      [localized('transactionDetailFetchedAt', 'Details fetched'), detail?.enrichment?.provider_detail_fetched_at]
    ])}
    ${section(localized('transactionDetailsTechnical', 'Technical local data'), [
      ['Lokale Umsatz-ID', transaction.id], ['Erstellt', transaction.created_at], ['Aktualisiert', transaction.updated_at]
    ])}
  `);
  const enrich = document.createElement('button');
  enrich.type = 'button';
  enrich.className = 'btn btn--secondary';
  enrich.dataset.action = 'enrich-transaction';
  enrich.dataset.transactionId = String(transaction.id ?? '');
  enrich.disabled = !detail?.enrichment?.transaction_id_available;
  enrich.textContent = localized('transactionEnrich', 'Refresh provider details');
  const hint = document.createElement('p');
  hint.className = 'banking-muted';
  hint.textContent = localized('transactionEnrichHint', 'Enable Banking can provide extra details only when the bank supplies a transaction ID.');
  host.append(enrich, hint);
  const raw = document.createElement('details');
  raw.className = 'banking-transaction-detail-raw';
  const summary = document.createElement('summary');
  summary.textContent = localized('transactionDetailsRaw', 'All provider raw data');
  raw.append(summary);
  if (detail?.provider_raw_available && detail.provider_raw !== null) {
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn--secondary';
    copy.textContent = localized('transactionDetailsCopyJson', 'Copy JSON');
    const feedback = document.createElement('p');
    feedback.className = 'banking-feedback';
    const pre = document.createElement('pre');
    // Provider data is untrusted. textContent is intentional here.
    pre.textContent = JSON.stringify(detail.provider_raw, null, 2);
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.textContent || '');
        feedback.textContent = localized('transactionDetailsJsonCopied', 'JSON copied.');
      } catch { feedback.textContent = localized('transactionDetailLoadFailed', 'Transaction details could not be loaded.'); }
    });
    raw.append(copy, feedback, pre);
  } else {
    const unavailable = document.createElement('p');
    unavailable.textContent = localized('transactionDetailsRawUnavailable', 'Provider raw data was not stored for this older import. A future sync can add it if the bank returns the transaction again.');
    raw.append(unavailable);
  }
  host.append(raw);
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

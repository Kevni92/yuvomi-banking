import {
  renderPageHeader,
  renderPageTitle,
  renderPageBody,
  renderPageSection
} from '/utils/page-layout.js';
import { esc } from '/utils/html.js';
import { t } from '/i18n.js';

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

  container.replaceChildren();
  container.insertAdjacentHTML(
    'beforeend',
    renderPageHeader({ title: renderPageTitle(localized('title', 'Banking')) }) +
      renderPageBody({
        content: renderPageSection({
          content: renderOverviewMarkup()
        })
      })
  );

  const statusNode = container.querySelector('[data-banking-status]');
  const userNode = container.querySelector('[data-banking-user]');
  const permissionNode = container.querySelector('[data-banking-permission]');

  const [healthResult, sessionResult] = await Promise.allSettled([
    loadJson('health', { signal }),
    loadJson('me', { signal })
  ]);
  if (signal.aborted) return;

  renderHealth(statusNode, healthResult);

  const session = sessionResult.status === 'fulfilled' ? sessionResult.value?.data : null;
  const permission = session?.banking_permission ?? 'none';
  container.dataset.bankingPermission = permission;
  if (session) {
    userNode.textContent = session.display_name || localized('unknownUser', 'Unknown user');
    permissionNode.textContent = permission;
    permissionNode.dataset.state = permission;
  } else {
    const error = sessionResult.reason;
    userNode.textContent = error instanceof Error
      ? error.message
      : localized('sessionUnavailable', 'Yuvomi session unavailable.');
    permissionNode.textContent = localized('noPermission', 'No permission');
    permissionNode.dataset.state = 'none';
  }

  configureConnectionForm(container, permission, signal);
  if (session) await loadOverview(container, signal, permission === 'write');
}

function renderOverviewMarkup() {
  return `
    <div class="banking-integration-grid" aria-live="polite">
      <article class="banking-integration-card">
        <span class="banking-integration-card__label">${esc(localized('sidecar', 'Banking sidecar'))}</span>
        <strong class="banking-integration-card__value" data-banking-status>${esc(localized('sidecarChecking', 'Checking connection ...'))}</strong>
      </article>

      <article class="banking-integration-card">
        <span class="banking-integration-card__label">${esc(localized('user', 'Signed-in Yuvomi user'))}</span>
        <strong class="banking-integration-card__value" data-banking-user>${esc(localized('checking', 'Checking ...'))}</strong>
      </article>

      <article class="banking-integration-card">
        <span class="banking-integration-card__label">${esc(localized('permission', 'Banking permission'))}</span>
        <strong class="banking-integration-card__value" data-banking-permission>${esc(localized('checking', 'Checking ...'))}</strong>
      </article>
    </div>

    <section class="banking-panel" data-banking-connect-panel>
      <div class="banking-panel__header">
        <div>
          <h2>${esc(localized('connectTitle', 'Bank connection'))}</h2>
          <p class="banking-panel__description">${esc(localized('connectDescription', 'Connect a bank through the Enable Banking sandbox.'))}</p>
        </div>
      </div>
      <form class="banking-connect-form" data-banking-connect-form>
        <label class="banking-field">
          <span>${esc(localized('country', 'Country'))}</span>
          <select class="form-input" data-banking-country>
            <option value="DE">${esc(localized('germany', 'Germany'))}</option>
            <option value="AT">${esc(localized('austria', 'Austria'))}</option>
            <option value="CH">${esc(localized('switzerland', 'Switzerland'))}</option>
          </select>
        </label>
        <label class="banking-field">
          <span>${esc(localized('bank', 'Bank'))}</span>
          <select class="form-input" data-banking-bank disabled>
            <option value="">${esc(localized('loadBanksFirst', 'Load banks first'))}</option>
          </select>
        </label>
        <div class="banking-connect-form__actions">
          <button class="btn btn--secondary" type="button" data-action="load-banks">
            ${esc(localized('loadBanks', 'Load banks'))}
          </button>
          <button class="btn btn--primary" type="submit" data-action="connect-bank" disabled>
            ${esc(localized('connectBank', 'Connect bank'))}
          </button>
        </div>
      </form>
      <p class="banking-feedback" data-banking-connect-feedback role="status"></p>
    </section>

    <section class="banking-panel">
      <div class="banking-panel__header">
        <div>
          <h2>${esc(localized('connectionsTitle', 'Bank connections'))}</h2>
          <p class="banking-panel__description">${esc(localized('connectionsDescription', 'Your connections are stored in the separate Banking database.'))}</p>
        </div>
        <button class="btn btn--secondary" type="button" data-action="reload-connections">
          ${esc(localized('reload', 'Reload'))}
        </button>
      </div>
      <div data-banking-connections aria-live="polite">
        <p class="banking-muted">${esc(localized('loading', 'Loading ...'))}</p>
      </div>
    </section>

    <section class="banking-panel" data-banking-weekly-budget>
      <div class="banking-panel__header">
        <div>
          <h2>${esc(localized('weeklyBudgetTitle', 'Weekly budget'))}</h2>
          <p class="banking-panel__description">${esc(localized('weeklyBudgetDescription', 'Sparkasse expenses and the current N26 balance determine the next refill.'))}</p>
        </div>
        <button class="btn btn--secondary" type="button" data-action="reload-weekly-budget">
          ${esc(localized('reload', 'Reload'))}
        </button>
      </div>

      <div data-weekly-budget-current aria-live="polite">
        <p class="banking-muted">${esc(localized('loading', 'Loading ...'))}</p>
      </div>

      <form class="banking-weekly-settings" data-weekly-budget-settings>
        <label class="banking-field banking-field--checkbox">
          <input type="checkbox" data-weekly-enabled>
          <span>${esc(localized('weeklyBudgetEnabled', 'Enable weekly budget'))}</span>
        </label>
        <label class="banking-field">
          <span>${esc(localized('weeklyBudgetSource', 'Source account'))}</span>
          <select class="form-input" data-weekly-source required></select>
        </label>
        <label class="banking-field">
          <span>${esc(localized('weeklyBudgetTarget', 'Target account'))}</span>
          <select class="form-input" data-weekly-target required></select>
        </label>
        <label class="banking-field">
          <span>${esc(localized('weeklyBudgetAmount', 'Weekly target in euros'))}</span>
          <input class="form-input" inputmode="decimal" placeholder="450,00" data-weekly-amount required>
        </label>
        <label class="banking-field">
          <span>${esc(localized('weeklyBudgetWeekday', 'Cutoff weekday'))}</span>
          <select class="form-input" data-weekly-weekday required>${weekdayOptions()}</select>
        </label>
        <label class="banking-field">
          <span>${esc(localized('weeklyBudgetTime', 'Cutoff time'))}</span>
          <input class="form-input" type="time" data-weekly-time required>
        </label>
        <label class="banking-field">
          <span>${esc(localized('weeklyBudgetTimezone', 'Timezone'))}</span>
          <input class="form-input" value="Europe/Berlin" data-weekly-timezone required>
        </label>
        <label class="banking-field">
          <span>${esc(localized('weeklyBudgetSyncOne', 'First daily sync'))}</span>
          <input class="form-input" type="time" data-weekly-sync-one required>
        </label>
        <label class="banking-field">
          <span>${esc(localized('weeklyBudgetSyncTwo', 'Second daily sync'))}</span>
          <input class="form-input" type="time" data-weekly-sync-two required>
        </label>
        <div class="banking-weekly-settings__actions">
          <button class="btn btn--primary" type="submit" data-action="save-weekly-budget">
            ${esc(localized('weeklyBudgetSave', 'Save settings'))}
          </button>
        </div>
        <p class="banking-feedback" data-weekly-budget-feedback role="status"></p>
      </form>

      <div class="banking-weekly-categories">
        <h3>${esc(localized('weeklyBudgetCategories', 'Weekly-budget categories'))}</h3>
        <p class="banking-panel__description">${esc(localized('weeklyBudgetCategoriesDescription', 'A transaction-specific setting overrides its category.'))}</p>
        <div data-weekly-budget-categories></div>
      </div>
    </section>

    <section class="banking-panel">
      <div class="banking-panel__header">
        <div>
          <h2>${esc(localized('accountsTitle', 'Accounts'))}</h2>
          <p class="banking-panel__description">${esc(localized('accountsDescription', 'Balances and transactions are loaded through the Banking sidecar.'))}</p>
        </div>
      </div>
      <div data-banking-accounts aria-live="polite">
        <p class="banking-muted">${esc(localized('loading', 'Loading ...'))}</p>
      </div>
    </section>

    <div class="banking-empty-state">
      <h2>${esc(localized('introTitle', 'Yuvomi Banking'))}</h2>
      <p>${esc(localized('description', 'The Banking module is connected to its separate sidecar.'))}</p>
    </div>
  `;
}

function renderHealth(statusNode, result) {
  if (result.status === 'fulfilled' && result.value?.ok === true) {
    statusNode.textContent = localized('sidecarConnected', 'Connected');
    statusNode.dataset.state = 'connected';
    return;
  }
  statusNode.textContent = result.reason instanceof Error
    ? result.reason.message
    : localized('sidecarDisconnected', 'Not connected');
  statusNode.dataset.state = 'disconnected';
}

function configureConnectionForm(container, permission, signal) {
  const form = container.querySelector('[data-banking-connect-form]');
  const country = container.querySelector('[data-banking-country]');
  const bank = container.querySelector('[data-banking-bank]');
  const loadButton = container.querySelector('[data-action="load-banks"]');
  const connectButton = container.querySelector('[data-action="connect-bank"]');
  const feedback = container.querySelector('[data-banking-connect-feedback]');
  const reloadButton = container.querySelector('[data-action="reload-connections"]');
  const weeklySettings = container.querySelector('[data-weekly-budget-settings]');
  const weeklyCategories = container.querySelector('[data-weekly-budget-categories]');
  const reloadWeeklyBudget = container.querySelector('[data-action="reload-weekly-budget"]');
  const aspspsByName = new Map();

  if (permission !== 'write') {
    const message = permission === 'read'
      ? localized('readOnly', 'Your Banking permission is read-only.')
      : localized('noPermission', 'No permission');
    feedback.textContent = message;
    for (const control of [country, bank, loadButton, connectButton]) control.disabled = true;
  }

  loadButton.addEventListener('click', () => {
    void loadBanks({ country, bank, connectButton, loadButton, feedback, aspspsByName, signal });
  }, { signal });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void startConnection({ country, bank, connectButton, loadButton, feedback, aspspsByName, signal });
  }, { signal });

  reloadButton.addEventListener('click', () => {
    void loadOverview(container, signal, permission === 'write');
  }, { signal });

  country.addEventListener('change', () => {
    bank.replaceChildren(createOption('', localized('loadBanksFirst', 'Load banks first')));
    aspspsByName.clear();
    bank.disabled = true;
    connectButton.disabled = true;
  }, { signal });

  container.querySelector('[data-banking-accounts]').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const card = button.closest('[data-banking-account-card]');
    if (button.dataset.action === 'show-account') {
      void loadAccountDetails({ card, button, signal });
    } else if (button.dataset.action === 'sync-account') {
      void syncAccount({ card, button, signal });
    }
  }, { signal });

  container.querySelector('[data-banking-accounts]').addEventListener('change', (event) => {
    const select = event.target.closest('select[data-weekly-budget-override]');
    if (!select) return;
    void updateTransactionWeeklyBudget({ container, select, signal });
  }, { signal });

  weeklySettings.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveWeeklyBudgetSettings({ container, form: weeklySettings, signal });
  }, { signal });

  weeklyCategories.addEventListener('change', (event) => {
    const checkbox = event.target.closest('input[data-weekly-category-id]');
    if (!checkbox) return;
    void updateCategoryWeeklyBudget({ container, checkbox, signal });
  }, { signal });

  reloadWeeklyBudget.addEventListener('click', () => {
    void refreshWeeklyBudget(container, signal, permission === 'write');
  }, { signal });
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

async function loadOverview(container, signal, canWrite) {
  const connectionsHost = container.querySelector('[data-banking-connections]');
  const accountsHost = container.querySelector('[data-banking-accounts]');
  const weeklyBudgetHost = container.querySelector('[data-weekly-budget-current]');
  const categoriesHost = container.querySelector('[data-weekly-budget-categories]');
  const [connectionsResult, accountsResult, weeklyBudgetResult, categoriesResult] = await Promise.allSettled([
    loadJson('connections', { signal }),
    loadJson('accounts', { signal }),
    loadJson('weekly-budget/current', { signal }),
    loadJson('categories', { signal })
  ]);
  if (signal.aborted) return;

  if (connectionsResult.status === 'fulfilled') {
    renderConnections(connectionsHost, connectionsResult.value?.data);
  } else {
    renderError(connectionsHost, connectionsResult.reason);
  }
  if (accountsResult.status === 'fulfilled') {
    renderAccounts(accountsHost, accountsResult.value?.data, canWrite);
  } else {
    renderError(accountsHost, accountsResult.reason);
  }
  const accounts = accountsResult.status === 'fulfilled' && Array.isArray(accountsResult.value?.data)
    ? accountsResult.value.data
    : [];
  if (weeklyBudgetResult.status === 'fulfilled') {
    renderWeeklyBudget(
      weeklyBudgetHost,
      container.querySelector('[data-weekly-budget-settings]'),
      weeklyBudgetResult.value?.data,
      accounts,
      canWrite
    );
  } else {
    renderError(weeklyBudgetHost, weeklyBudgetResult.reason);
  }
  if (categoriesResult.status === 'fulfilled') {
    renderWeeklyBudgetCategories(categoriesHost, categoriesResult.value?.data, canWrite);
  } else {
    renderError(categoriesHost, categoriesResult.reason);
  }
}

function renderWeeklyBudget(host, form, current, accounts, canWrite) {
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
    `);
  }

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

async function refreshWeeklyBudget(container, signal, canWrite = container.dataset.bankingPermission === 'write') {
  const host = container.querySelector('[data-weekly-budget-current]');
  const categoriesHost = container.querySelector('[data-weekly-budget-categories]');
  const [currentResult, accountsResult, categoriesResult] = await Promise.allSettled([
    loadJson('weekly-budget/current', { signal }),
    loadJson('accounts', { signal }),
    loadJson('categories', { signal })
  ]);
  if (signal.aborted) return;
  if (currentResult.status === 'fulfilled' && accountsResult.status === 'fulfilled') {
    const accounts = Array.isArray(accountsResult.value?.data) ? accountsResult.value.data : [];
    renderWeeklyBudget(
      host,
      container.querySelector('[data-weekly-budget-settings]'),
      currentResult.value?.data,
      accounts,
      canWrite
    );
  } else {
    renderError(host, currentResult.status === 'rejected' ? currentResult.reason : accountsResult.reason);
  }
  if (categoriesResult.status === 'fulfilled') {
    renderWeeklyBudgetCategories(categoriesHost, categoriesResult.value?.data, canWrite);
  } else {
    renderError(categoriesHost, categoriesResult.reason);
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
        target_amount_cents: targetAmountCents,
        cutoff_weekday: Number(form.querySelector('[data-weekly-weekday]').value),
        cutoff_time: form.querySelector('[data-weekly-time]').value,
        timezone: form.querySelector('[data-weekly-timezone]').value,
        sync_time_1: form.querySelector('[data-weekly-sync-one]').value,
        sync_time_2: form.querySelector('[data-weekly-sync-two]').value,
        balance_stale_after_minutes: Number(form.dataset.balanceStaleAfterMinutes || 840),
        notification_enabled: form.dataset.notificationEnabled === 'true',
        notification_user_id: form.dataset.notificationUserId
          ? Number(form.dataset.notificationUserId)
          : null,
        notification_qr_preview: form.dataset.notificationQrPreview === 'true',
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
    await refreshWeeklyBudget(container, signal, true);
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
    host.insertAdjacentHTML('beforeend', `
      <article class="banking-account-card" data-banking-account-card data-account-id="${esc(id)}" data-can-write="${canWrite ? 'true' : 'false'}">
        <div class="banking-account-card__header">
          <div>
            <h3>${esc(account?.display_name || localized('unknownAccount', 'Bank account'))}</h3>
            <p>${esc(account?.iban_masked || account?.account_type || '')} ${esc(account?.currency || '')}</p>
          </div>
          <div class="banking-account-card__actions">
            <button class="btn btn--secondary" type="button" data-action="show-account" data-account-id="${esc(id)}">
              ${esc(localized('showAccount', 'Show details'))}
            </button>
            ${canWrite ? `<button class="btn btn--primary" type="button" data-action="sync-account" data-account-id="${esc(id)}">
              ${esc(localized('syncAccount', 'Synchronize'))}
            </button>` : ''}
          </div>
        </div>
        <p class="banking-feedback" data-account-feedback role="status"></p>
        <div class="banking-account-card__details" data-account-details hidden>
          <div>
            <h4>${esc(localized('balances', 'Balances'))}</h4>
            <div data-account-balances><p class="banking-muted">${esc(localized('notLoaded', 'Not loaded yet.'))}</p></div>
          </div>
          <div>
            <h4>${esc(localized('transactions', 'Transactions'))}</h4>
            <div data-account-transactions><p class="banking-muted">${esc(localized('notLoaded', 'Not loaded yet.'))}</p></div>
          </div>
        </div>
      </article>
    `);
  }
}

async function loadAccountDetails({ card, button, signal }) {
  if (!card) return;
  const accountId = card.dataset.accountId;
  if (!/^\d+$/.test(accountId)) return;
  const feedback = card.querySelector('[data-account-feedback]');
  const balancesHost = card.querySelector('[data-account-balances]');
  const transactionsHost = card.querySelector('[data-account-transactions]');
  const details = card.querySelector('[data-account-details]');
  button.disabled = true;
  card.setAttribute('aria-busy', 'true');
  feedback.textContent = localized('loadingDetails', 'Loading account details ...');
  try {
    const [balancesResult, transactionsResult] = await Promise.allSettled([
      loadJson(`accounts/${encodeURIComponent(accountId)}/balances`, { signal }),
      loadJson(`accounts/${encodeURIComponent(accountId)}/transactions`, { signal })
    ]);
    if (signal.aborted) return;

    details.hidden = false;
    if (balancesResult.status === 'fulfilled') renderBalances(balancesHost, balancesResult.value?.data);
    else renderError(balancesHost, balancesResult.reason);
    if (transactionsResult.status === 'fulfilled') {
      renderTransactions(
        transactionsHost,
        transactionsResult.value?.data?.transactions,
        card.dataset.canWrite === 'true'
      );
      feedback.textContent = localized('detailsLoaded', 'Account details loaded.');
    } else {
      renderError(transactionsHost, transactionsResult.reason);
      feedback.textContent = transactionsResult.reason instanceof Error
        ? transactionsResult.reason.message
        : localized('detailsFailed', 'Account details could not be loaded.');
    }
  } catch (error) {
    if (!signal.aborted) feedback.textContent = error instanceof Error
      ? error.message
      : localized('detailsFailed', 'Account details could not be loaded.');
  } finally {
    if (!signal.aborted) {
      button.disabled = false;
      card.removeAttribute('aria-busy');
    }
  }
}

async function syncAccount({ card, button, signal }) {
  if (!card) return;
  const accountId = card.dataset.accountId;
  if (!/^\d+$/.test(accountId)) return;
  const feedback = card.querySelector('[data-account-feedback]');
  const balancesHost = card.querySelector('[data-account-balances]');
  const transactionsHost = card.querySelector('[data-account-transactions]');
  const details = card.querySelector('[data-account-details]');
  button.disabled = true;
  card.setAttribute('aria-busy', 'true');
  feedback.textContent = localized('syncing', 'Synchronizing ...');
  try {
    const csrf = await loadJson('csrf', { signal });
    const csrfToken = typeof csrf?.csrf_token === 'string' ? csrf.csrf_token : '';
    const [balancesResult, syncResult] = await Promise.allSettled([
      loadJson(`accounts/${encodeURIComponent(accountId)}/balances`, { signal }),
      loadJson(`accounts/${encodeURIComponent(accountId)}/sync`, {
        method: 'POST',
        headers: { 'x-banking-csrf': csrfToken },
        signal
      })
    ]);
    if (signal.aborted) return;

    details.hidden = false;
    if (balancesResult.status === 'fulfilled') renderBalances(balancesHost, balancesResult.value?.data);
    else renderError(balancesHost, balancesResult.reason);
    if (syncResult.status === 'fulfilled') {
      const data = syncResult.value?.data;
      renderTransactions(transactionsHost, data?.transactions, card.dataset.canWrite === 'true');
      const imported = data?.imported;
      feedback.textContent = imported
        ? localized('syncComplete', 'Sync complete: {inserted} new, {updated} updated.', {
            inserted: imported.inserted ?? 0,
            updated: imported.updated ?? 0
          })
        : localized('syncCompleteShort', 'Sync complete.');
    } else {
      renderError(transactionsHost, syncResult.reason);
      feedback.textContent = syncResult.reason instanceof Error
        ? syncResult.reason.message
        : localized('syncFailed', 'Synchronization failed.');
    }
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

function renderTransactions(host, transactions, canWrite = false) {
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
    return `
      <li class="banking-transaction-row">
        <div>
          <strong>${esc(String(title))}</strong>
          <span>${esc(formatDate(transactionDate) || '')}${subtitle ? ` · ${esc(String(subtitle))}` : ''} · ${esc(statusText)}</span>
          ${/^\d+$/.test(transactionId) ? `<label class="banking-transaction-budget">
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
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return '';
  return value.slice(0, 10);
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

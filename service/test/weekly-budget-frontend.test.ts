import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

function moduleFile(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), '../modules/banking', relativePath), 'utf8');
}

function bankingStyle(): string {
  return readFileSync(resolve(process.cwd(), '../modules/banking/style.css'), 'utf8');
}

test('banking page exposes weekly-budget settings and both override controls', () => {
  const source = moduleFile('index.js');
  for (const marker of [
    "loadJson('weekly-budget/current'",
    "loadJson('weekly-budget/settings'",
    "loadJson('categories'",
    "loadJson('weekly-budget/periods'",
    "loadJson('categorization/reviews'",
    "loadJson('category-suggestions'",
    'data-banking-category-management',
    'data-banking-category-dialog',
    '#banking-category-dialog-title',
    'data-action="add-category"',
    'data-action="save-category"',
    'refreshCategoryDependentViews',
    'transactionCategoryOptions',
    'data-weekly-period-id',
    'data-action="recalculate-weekly-period"',
    'data-action="dismiss-weekly-transfer"',
    'weekly-budget/periods/${encodeURIComponent(periodId)}/recalculate',
    'weekly-budget/transfers/${encodeURIComponent(suggestionId)}/dismiss',
    'data-weekly-budget-override',
    'data-transaction-category-id',
    'transactions/${encodeURIComponent(transactionId)}/category',
    'data-action="load-merchant-logos"',
    'merchant-logos/refresh',
    'merchant_logo_available',
    'data-banking-categorization',
    'data-action="run-categorization"',
    'categorizationNoCategoriesHint',
    'data-categorization-suggestion-id',
    'accept-category-suggestion',
    'dismiss-category-suggestion',
    'category-suggestions/${encodeURIComponent(suggestionId)}',
    "loadJson('categorization/run'",
    "weekly_budget_override: select.value",
    'target_amount_cents: targetAmountCents',
    'target_beneficiary_name:',
    'girocode.png',
    "cutoff_time: form.querySelector('[data-weekly-time]').value",
    "loadJson('push/vapid-public-key'",
    "loadJson('push/subscriptions'",
    "loadJson('push/recipients'",
    "api.get('/auth/users')",
    'data-weekly-notifications-enabled',
    'data-weekly-notification-recipient',
    'data-weekly-notification-qr-preview',
    "navigator.serviceWorker.register('/modules/banking/push-worker.js'",
    "scope: '/modules/banking/'",
    "loadJson('push/test'",
    "loadJson('openai/settings'",
    "loadJson('openai/models'",
    'data-openai-api-key',
    'data-openai-model',
    'data-action="load-openai-models"',
    'data-action="save-openai-settings"',
    'api_key_configured',
  ]) assert.ok(source.includes(marker), `Missing frontend contract marker: ${marker}`);

  assert.doesNotMatch(source, /https?:\/\//i);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
});

test('banking redesign keeps configuration out of the main view and exposes a global transaction table', () => {
  const source = moduleFile('index.js');
  for (const marker of [
    'renderMainMarkup()',
    'renderSettingsMarkup()',
    'renderTransactionsPanelMarkup()',
    "new URLSearchParams(window.location.search).get('view')",
    'transactions?${params.toString()}',
    'data-banking-transactions-panel',
    'data-transaction-filters',
    'data-transaction-sort',
    'data-transaction-page',
    'yuvomi:banking:transactions-open',
    'data-banking-accounts-panel',
    'yuvomi:banking:accounts-open',
    'aria-expanded',
    'aria-controls',
    'hideAccountDetails',
    'settingsTitle',
    'backToBanking'
  ]) assert.ok(source.includes(marker), `Missing redesign contract marker: ${marker}`);
  assert.match(JSON.parse(moduleFile('module.json')).page.width, /^wide$/);
  assert.doesNotMatch(source, /data-account-transactions/);
  assert.match(source, /function formatDate\(value\)[\s\S]*new Intl\.DateTimeFormat\(undefined, \{ dateStyle: 'short' \}\)/);
  assert.doesNotMatch(source, /return value\.slice\(0, 10\)/);
  assert.match(bankingStyle(), /\.banking-account-card__details\[hidden\]\s*\{\s*display:\s*none;/);
  assert.doesNotMatch(source, /balancesResult\.(status|value|reason)/);

  const syncSource = source.slice(source.indexOf('async function syncAccount'), source.indexOf('async function loadMerchantLogos'));
  assert.match(syncSource, /const wasOpen = !details\.hidden/);
  assert.doesNotMatch(syncSource, /details\.hidden\s*=\s*false/);
  assert.match(source, /syncAccount\(\{ container, card, button, signal \}\)/);
  assert.doesNotMatch(syncSource, /card\.closest\('\[data-composition\]'\)/);
  assert.match(source, /if \(categoriesHost\)/);
  assert.match(source, /if \(historyHost\)/);
});

test('banking push worker is scoped to the module and never imports app-shell code', () => {
  const worker = moduleFile('push-worker.js');
  assert.match(worker, /self\.addEventListener\('push'/);
  assert.match(worker, /self\.addEventListener\('notificationclick'/);
  assert.match(worker, /showNotification/);
  assert.match(worker, /clients\.openWindow/);
  assert.doesNotMatch(worker, /importScripts|https?:\/\//i);
});

test('dashboard widget reads the local current-weekly-budget endpoint', () => {
  const source = moduleFile('widgets/weekly-budget.js');
  const manifest = JSON.parse(moduleFile('module.json')) as {
    capabilities?: { widgets?: Array<{ id?: string; defaultVisible?: boolean }> };
  };
  const widget = manifest.capabilities?.widgets?.find((entry) => entry.id === 'weekly-budget');
  assert.ok(widget, 'weekly-budget widget must remain registered');
  assert.equal(widget.defaultVisible, true);
  assert.match(source, /\/api\/extensions\/banking\/weekly-budget\/current/);
  assert.match(source, /available_to_spend_cents/);
  assert.match(source, /period\?\.next_cutoff_at/);
  assert.match(source, /wrapper\.dataset\.route\s*=\s*['"]\/m\/banking/);
  assert.match(source, /wrapper\.href\s*=\s*['"]\/m\/banking/);
  assert.match(source, /banking-weekly-widget__title/);
  assert.match(source, /banking-weekly-widget__content/);
  assert.match(source, /banking-weekly-widget__progress/);
  assert.match(source, /banking-weekly-widget__progress-fill/);
  assert.match(source, /banking-weekly-widget__remaining/);
  assert.match(source, /progress\.setAttribute\('role', 'progressbar'\)/);
  assert.match(source, /progress\.setAttribute\('aria-valuenow', String\(percentage\)\)/);
  assert.doesNotMatch(source, /transfer_amount_cents/);
  assert.doesNotMatch(source, /https?:\/\//i);
  const style = bankingStyle();
  assert.match(style, /\.banking-weekly-widget\s*\{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\)/s);
  assert.match(style, /\.banking-weekly-widget__content\s*\{[^}]*align-content:\s*center;[^}]*justify-items:\s*center/s);
  assert.match(style, /\.banking-weekly-widget__amount\s*\{[^}]*font-size:\s*clamp\(/s);
  assert.match(style, /\.banking-weekly-widget__progress-fill\s*\{[^}]*background:\s*var\(--color-accent/s);
});

test('dashboard widget countdown handles exact, partial and invalid cutoffs', async () => {
  const widget = await import(pathToFileURL(resolve(process.cwd(), '../modules/banking/widgets/weekly-budget.js')).href) as {
    calculateRemainingWeeklyBudgetProgress: (nextCutoffAt: unknown, now?: number | Date) => number | null;
    calculateRemainingWeeklyBudgetDays: (nextCutoffAt: unknown, now?: number | Date) => number | null;
    formatRemainingWeeklyBudget: (nextCutoffAt: unknown, now?: number | Date, locale?: string) => string;
  };
  const now = Date.parse('2026-09-11T10:00:00.000Z');
  const day = 24 * 60 * 60 * 1000;
  const cutoff = (days: number) => new Date(now + days * day).toISOString();

  assert.equal(widget.calculateRemainingWeeklyBudgetProgress(cutoff(7), now), 1);
  assert.ok(Math.abs(widget.calculateRemainingWeeklyBudgetProgress(cutoff(6), now)! - (6 / 7)) < 1e-10);
  assert.equal(widget.calculateRemainingWeeklyBudgetProgress(cutoff(3.5), now), 0.5);
  assert.ok(Math.abs(widget.calculateRemainingWeeklyBudgetProgress(cutoff(1), now)! - (1 / 7)) < 1e-10);
  assert.equal(widget.calculateRemainingWeeklyBudgetProgress(cutoff(0), now), 0);
  assert.equal(widget.calculateRemainingWeeklyBudgetProgress(cutoff(-1), now), 0);
  assert.equal(widget.calculateRemainingWeeklyBudgetProgress(cutoff(8), now), 1);
  assert.equal(widget.calculateRemainingWeeklyBudgetProgress(undefined, now), null);
  assert.equal(widget.calculateRemainingWeeklyBudgetProgress('not-a-date', now), null);

  assert.equal(widget.calculateRemainingWeeklyBudgetDays(cutoff(5.2), now), 6);
  assert.equal(widget.formatRemainingWeeklyBudget(cutoff(1), now, 'de'), 'noch 1 Tag');
  assert.equal(widget.formatRemainingWeeklyBudget(cutoff(0.5), now, 'de'), 'noch 1 Tag');
  assert.equal(widget.formatRemainingWeeklyBudget(cutoff(0), now, 'de'), 'noch heute');
  assert.equal(widget.formatRemainingWeeklyBudget(cutoff(-1), now, 'en'), 'ends today');
  assert.equal(widget.formatRemainingWeeklyBudget(undefined, now, 'de'), 'Zeitraum nicht verfügbar');
  assert.equal(widget.formatRemainingWeeklyBudget('not-a-date', now, 'en'), 'Period unavailable.');
});

test('weekly-budget locale keys exist in German and English', () => {
  const german = JSON.parse(moduleFile('locales/de.json')) as Record<string, string>;
  const english = JSON.parse(moduleFile('locales/en.json')) as Record<string, string>;
  for (const key of [
    'weeklyBudgetTitle',
    'weeklyBudgetAvailable',
    'weeklyBudgetSource',
    'weeklyBudgetTarget',
    'accountRoleMain',
    'accountRoleBudget',
    'weeklyBudgetBeneficiary',
    'weeklyBudgetGiroCode',
    'weeklyBudgetWeekday',
    'weeklyBudgetTime',
    'weeklyBudgetCategories',
    'weeklyBudgetHistory',
    'weeklyBudgetShowDetails',
    'hideAccountDetails',
    'weeklyBudgetRecalculate',
    'weeklyBudgetDismissSuggestion',
    'weeklyBudgetLateCandidates',
    'weeklyBudgetClosingBalance',
    'weeklyBudgetRevisions',
    'weeklyBudgetDirectCount',
    'weeklyBudgetDirectCountPlural',
    'weeklyBudgetDirectPeriod',
    'weeklyBudgetShowDirectExpenses',
    'weeklyBudgetDecisionCategoryDefault',
    'weeklyBudgetDecisionTransactionOverride',
    'weeklyBudgetInherit',
    'weeklyBudgetInclude',
    'weeklyBudgetExclude',
    'transactionCategory',
    'categoryRuleSaved',
    'categorizationTitle',
    'categorizationRun',
    'categorizationDone',
    'categorizationSuggestionsTitle',
    'categorizationAcceptSuggestion',
    'loadMerchantLogos',
    'merchantLogosLoaded',
    'pushTitle',
    'pushEnable',
    'pushTestQueued',
    'weeklyBudgetNotifications',
    'weeklyBudgetNotificationRecipient',
    'weeklyBudgetNotificationQrPreview',
    'openAiSettingsTitle',
    'openAiApiKey',
    'openAiModel',
    'openAiLoadModels',
    'openAiSaved'
    , 'categoriesTitle'
    , 'categoryAdd'
    , 'categoryReactivate'
    , 'inactiveCategories'
  ]) {
    assert.ok(german[key], `Missing German locale key ${key}`);
    assert.ok(english[key], `Missing English locale key ${key}`);
  }
});

test('weekly-budget summary exposes its inclusive calendar period and included expenses', () => {
  const source = moduleFile('index.js');
  assert.match(source, /function formatInclusiveDateRange\(startDate, exclusiveEndDate\)/);
  assert.match(source, /weeklyBudgetDirectExpenseSummary\(directExpenseCount, directExpensePeriod\)/);
  assert.match(source, /weeklyDirectExpensesMarkup\(directExpenses, settings\?\.currency\)/);
  assert.match(source, /weeklyBudgetDecisionCategoryDefault/);
  assert.match(source, /weeklyBudgetDecisionTransactionOverride/);
});

test('weekly-budget user-facing source stays provider-neutral', () => {
  const source = [
    moduleFile('index.js'),
    moduleFile('locales/de.json'),
    moduleFile('locales/en.json'),
    moduleFile('widgets/weekly-budget.js')
  ].join('\n');
  assert.doesNotMatch(source, /N26|Sparkasse|Sparkassen/i);
});

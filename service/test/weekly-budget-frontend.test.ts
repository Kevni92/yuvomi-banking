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

function weeklyBudgetWidgetStyle(): string {
  return moduleFile('widgets/weekly-budget.css');
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

test('dashboard widget renders budget, trend and segmented week progress from local Banking APIs', () => {
  const source = moduleFile('widgets/weekly-budget.js');
  const manifest = JSON.parse(moduleFile('module.json')) as {
    capabilities?: { widgets?: Array<{ id?: string; defaultVisible?: boolean }> };
  };
  const widget = manifest.capabilities?.widgets?.find((entry) => entry.id === 'weekly-budget');
  assert.ok(widget, 'weekly-budget widget must remain registered');
  assert.equal(widget.defaultVisible, true);
  assert.match(source, /\/api\/extensions\/banking\/weekly-budget\/current/);
  assert.match(source, /\/api\/extensions\/banking\/transactions\?/);
  assert.match(source, /available_to_spend_cents/);
  assert.match(source, /target_amount_cents/);
  assert.match(source, /period\?\.next_cutoff_at/);
  assert.match(source, /wrapper\.dataset\.route\s*=\s*['"]\/m\/banking/);
  assert.match(source, /wrapper\.href\s*=\s*['"]\/m\/banking/);
  for (const marker of [
    'banking-weekly-widget__header',
    'banking-weekly-widget__amount',
    'banking-weekly-widget__baseline',
    'banking-weekly-widget__budget-progress',
    'banking-weekly-widget__budget-progress-fill',
    'banking-weekly-widget__budget-percent',
    'banking-weekly-widget__trend',
    'banking-weekly-widget__trend-badge',
    'banking-weekly-widget__sparkline',
    'banking-weekly-widget__week-progress',
    'banking-weekly-widget__week-labels'
  ]) assert.ok(source.includes(marker), `Missing dashboard widget marker: ${marker}`);
  assert.match(source, /budgetProgress\.setAttribute\('role', 'progressbar'\)/);
  assert.match(source, /weekProgress\.setAttribute\('role', 'progressbar'\)/);
  assert.match(source, /calculateBudgetTrendState/);
  assert.match(source, /buildBudgetTrendPoints/);
  assert.match(source, /buildBudgetWeekSegments/);
  assert.doesNotMatch(source, /transfer_amount_cents/);
  assert.doesNotMatch(source, /https?:\/\//i);

  const style = weeklyBudgetWidgetStyle();
  assert.match(style, /\.banking-weekly-widget__amount\s*\{[^}]*font-size:\s*clamp\(/s);
  assert.match(style, /\.banking-weekly-widget__budget-progress-fill\s*\{[^}]*linear-gradient/s);
  assert.match(style, /\.banking-weekly-widget__trend\s*\{[^}]*border-radius:/s);
  assert.match(style, /\.banking-weekly-widget__week-progress,[\s\S]*grid-template-columns:\s*repeat\(7,/s);
  assert.match(style, /data-state="past"/);
  assert.match(style, /data-state="current"/);
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

test('dashboard widget budget trend compares remaining money with remaining week', async () => {
  const widget = await import(pathToFileURL(resolve(process.cwd(), '../modules/banking/widgets/weekly-budget.js')).href) as {
    calculateBudgetTrendState: (budgetRatio: number, remainingWeekRatio: number, tolerance?: number) => string;
    budgetColorForRatio: (ratio: number) => string;
    buildBudgetWeekSegments: (periodEndDate: string, now?: number | Date, timezone?: string, locale?: string) => Array<{ date: string; label: string; state: string }>;
    buildBudgetTrendPoints: (current: unknown, transactions: unknown[], now?: number | Date) => number[];
  };

  assert.equal(widget.calculateBudgetTrendState(0.10, 0.60), 'under');
  assert.equal(widget.calculateBudgetTrendState(0.55, 0.50), 'on');
  assert.equal(widget.calculateBudgetTrendState(0.80, 0.40), 'over');
  assert.match(widget.budgetColorForRatio(0), /^hsl\(0 /);
  assert.match(widget.budgetColorForRatio(1), /^hsl\(120 /);

  const segments = widget.buildBudgetWeekSegments(
    '2026-09-17',
    Date.parse('2026-09-12T10:00:00.000Z'),
    'Europe/Berlin',
    'de'
  );
  assert.equal(segments.length, 7);
  assert.deepEqual(segments.map((entry) => entry.label), ['Do', 'Fr', 'Sa', 'So', 'Mo', 'Di', 'Mi']);
  assert.equal(segments[2].state, 'current');

  const current = {
    available_to_spend_cents: 4500,
    settings: { target_amount_cents: 45000, timezone: 'Europe/Berlin' },
    period: { start_date: '2026-09-10', end_date: '2026-09-17' }
  };
  const points = widget.buildBudgetTrendPoints(current, [
    { booking_date: '2026-09-10', amount: '20.00', direction: 'outgoing' },
    { booking_date: '2026-09-11', amount: '10.00', direction: 'outgoing' }
  ], Date.parse('2026-09-12T10:00:00.000Z'));
  assert.equal(points.at(-1), 4500);
  assert.ok(points.length >= 2);
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

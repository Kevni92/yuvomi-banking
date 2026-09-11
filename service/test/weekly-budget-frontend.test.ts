import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

function moduleFile(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), '../modules/banking', relativePath), 'utf8');
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
    'data-weekly-category-id',
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
    "navigator.serviceWorker.register('/modules/banking/push-worker.js'",
    "scope: '/modules/banking/'",
    "loadJson('push/test'"
  ]) assert.ok(source.includes(marker), `Missing frontend contract marker: ${marker}`);

  assert.doesNotMatch(source, /https?:\/\//i);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
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
  assert.match(source, /\/api\/extensions\/banking\/weekly-budget\/current/);
  assert.match(source, /available_to_spend_cents/);
  assert.match(source, /transfer_amount_cents/);
  assert.doesNotMatch(source, /https?:\/\//i);
});

test('weekly-budget locale keys exist in German and English', () => {
  const german = JSON.parse(moduleFile('locales/de.json')) as Record<string, string>;
  const english = JSON.parse(moduleFile('locales/en.json')) as Record<string, string>;
  for (const key of [
    'weeklyBudgetTitle',
    'weeklyBudgetAvailable',
    'weeklyBudgetSource',
    'weeklyBudgetTarget',
    'weeklyBudgetBeneficiary',
    'weeklyBudgetGiroCode',
    'weeklyBudgetWeekday',
    'weeklyBudgetTime',
    'weeklyBudgetCategories',
    'weeklyBudgetHistory',
    'weeklyBudgetShowDetails',
    'weeklyBudgetRecalculate',
    'weeklyBudgetDismissSuggestion',
    'weeklyBudgetLateCandidates',
    'weeklyBudgetClosingBalance',
    'weeklyBudgetRevisions',
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
    'weeklyBudgetNotificationRecipient'
  ]) {
    assert.ok(german[key], `Missing German locale key ${key}`);
    assert.ok(english[key], `Missing English locale key ${key}`);
  }
});

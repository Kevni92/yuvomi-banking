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
    'data-weekly-category-id',
    'data-weekly-budget-override',
    "weekly_budget_override: select.value",
    'target_amount_cents: targetAmountCents',
    'target_beneficiary_name:',
    'girocode.png',
    "cutoff_time: form.querySelector('[data-weekly-time]').value"
  ]) assert.ok(source.includes(marker), `Missing frontend contract marker: ${marker}`);

  assert.doesNotMatch(source, /https?:\/\//i);
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
    'weeklyBudgetInherit',
    'weeklyBudgetInclude',
    'weeklyBudgetExclude'
  ]) {
    assert.ok(german[key], `Missing German locale key ${key}`);
    assert.ok(english[key], `Missing English locale key ${key}`);
  }
});

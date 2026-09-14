import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

function source(): string {
  return readFileSync(resolve(process.cwd(), '../modules/banking/index.js'), 'utf8');
}

function locale(language: string): Record<string, string> {
  return JSON.parse(readFileSync(resolve(process.cwd(), `../modules/banking/locales/${language}.json`), 'utf8')) as Record<string, string>;
}

test('recurring payee UI uses isolated state, the shared transaction renderer, and safe output', () => {
  const code = source();
  for (const marker of [
    'data-banking-recurring-payees',
    'data-banking-payee-dialog',
    "loadJson(`payees?${params.toString()}`",
    'createPayeeListState()',
    'createPayeeTransactionState(payeeId)',
    'data-payee-transaction-sort',
    'data-payee-transaction-page',
    'data-payee-dialog-category-id',
    'remember_counterparty: !inPayeeDialog',
    'renderTransactionTable(tableHost',
    'data-payee-transaction-page-size'
  ]) assert.ok(code.includes(marker), `Missing recurring-payee UI marker: ${marker}`);
  assert.doesNotMatch(code, /\.innerHTML\s*=/);
  assert.match(code, /function renderPayeeList\([\s\S]*?host\.insertAdjacentHTML\('beforeend', `[^`]*\$\{rows\}/);
  assert.match(code, /function renderPayeeDialogCategory\([\s\S]*?\.textContent/);
  for (const language of ['de', 'en']) {
    const translations = locale(language);
    for (const key of ['recurringPayeesTitle', 'recurringPayeesDescription', 'recurringPayeeCandidate', 'recurringPayeeConfirmDescription', 'recurringPayeeManualExceptions', 'recurringPayeesMultipleCurrencies']) {
      assert.equal(typeof translations[key], 'string', `Missing ${language} locale key: ${key}`);
    }
  }
});

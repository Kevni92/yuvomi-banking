import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = path.resolve(here, '../../../modules/banking');
const entry = fs.readFileSync(path.join(moduleRoot, 'entry.js'), 'utf8');
const polish = fs.readFileSync(path.join(moduleRoot, 'transaction-sync-polish.js'), 'utf8');
const style = fs.readFileSync(path.join(moduleRoot, 'transaction-sync-polish.css'), 'utf8');

test('banking entry captures the current transaction payload and installs sync polish', () => {
  assert.match(entry, /latestTransactions/);
  assert.match(entry, /\/api\/extensions\/banking\/transactions/);
  assert.match(entry, /installTransactionSyncPolish/);
});

test('transaction date cell renders provider-derived time on a secondary line', () => {
  assert.match(polish, /transaction_time/);
  assert.match(polish, /banking-transactions-table__date-stack/);
  assert.match(polish, /banking-transactions-table__date-time/);
  assert.match(style, /\.banking-transactions-table__date-time/);
});

test('latest imported transactions get a synthetic visual separator without creating a transaction', () => {
  assert.match(polish, /new_since_last_sync/);
  assert.match(polish, /banking-recent-sync-separator/);
  assert.match(polish, /seit letztem Abruf/);
  assert.match(polish, /banking-budget-week-separator/);
  assert.match(style, /\.banking-recent-sync-separator__content::before/);
  assert.match(style, /\.banking-recent-sync-separator__content::after/);
});

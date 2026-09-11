import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../../../modules/banking/index.js'), 'utf8');

test('transaction UI exposes the compact-list and safe-detail contract', () => {
  for (const marker of [
    'data-action="toggle-transaction-filters"',
    'data-transaction-filter-count',
    'data-transaction-columns-menu',
    'data-transaction-row',
    'data-banking-transaction-dialog',
    'data-action="transaction-details"',
    'data-transaction-page-size',
    'banking-transaction-status--${statusClass}',
    'banking-table-select'
  ]) assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(source, /data-transaction-filters[^]*Apply filters/);
  assert.match(source, /pre\.textContent = JSON\.stringify\(detail\.provider_raw, null, 2\)/);
  assert.doesNotMatch(source, /innerHTML\s*=\s*JSON\.stringify\(detail\.provider_raw/);
  assert.match(source, /data-transaction-category-id/);
  assert.match(source, /data-weekly-budget-override/);
  assert.match(source, /formatTransactionAmount/);
});

test('transaction UI keeps merchant, counterparty and purpose fallback order', () => {
  assert.match(
    source,
    /transaction\?\.merchant_name \|\| transaction\?\.counterparty_name \|\| transaction\?\.purpose \|\| localized\('unknownTransaction'/
  );
});

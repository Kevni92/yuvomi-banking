import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../../../modules/banking/index.js'), 'utf8');
const style = fs.readFileSync(path.resolve(here, '../../../modules/banking/style.css'), 'utf8');

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

test('transaction and category dialogs keep a single scrolling body', () => {
  assert.match(source, /<dialog class="banking-transaction-dialog"[^>]*>[\s\S]*?<div class="banking-transaction-dialog__header">[\s\S]*?<\/div>[\s\S]*?<div class="banking-transaction-dialog__body" data-banking-transaction-dialog-content><\/div>[\s\S]*?<\/dialog>/);
  assert.match(source, /class="banking-transaction-detail-summary"/);
  assert.doesNotMatch(source, /renderTransactionDetail[\s\S]*?banking-transaction-dialog__header/);
  assert.match(source, /<dialog class="banking-category-dialog"[\s\S]*?banking-category-dialog__header[\s\S]*?banking-category-dialog__body[\s\S]*?banking-category-dialog__footer[\s\S]*?<\/dialog>/);

  assert.match(style, /\.banking-transaction-dialog\s*\{[^}]*overflow:\s*hidden;/s);
  assert.match(style, /\.banking-transaction-dialog__body\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s);
  assert.doesNotMatch(style, /\.banking-transaction-dialog__body\s*\{[^}]*max-height\s*:/s);
  assert.match(style, /@media\s*\(max-width:\s*42rem\)[\s\S]*?\.banking-transaction-detail-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s);
  assert.match(style, /\.banking-transaction-detail-raw\s+pre\s*\{[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*visible;/s);
  assert.doesNotMatch(style, /\.banking-transaction-detail-raw\s+pre\s*\{[^}]*max-height\s*:/s);
  assert.match(style, /\.banking-category-dialog\s*\{[^}]*overflow:\s*hidden;/s);
  assert.match(style, /\.banking-category-dialog__body\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s);
});

test('transaction UI keeps merchant, counterparty and purpose fallback order', () => {
  assert.match(
    source,
    /transaction\?\.merchant_name \|\| transaction\?\.counterparty_name \|\| transaction\?\.purpose \|\| localized\('unknownTransaction'/
  );
});

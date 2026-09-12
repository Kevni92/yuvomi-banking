import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = path.resolve(here, '../../../modules/banking');
const entry = fs.readFileSync(path.join(moduleRoot, 'entry.js'), 'utf8');
const polish = fs.readFileSync(path.join(moduleRoot, 'layout-polish.js'), 'utf8');
const style = fs.readFileSync(path.join(moduleRoot, 'layout-polish.css'), 'utf8');
const tableCompatStyle = fs.readFileSync(path.join(moduleRoot, 'table-layout-compat.css'), 'utf8');

test('main banking layout installs the polish layer after the enhanced renderer', () => {
  assert.match(entry, /installMainLayoutPolish/);
  assert.match(entry, /await renderEnhanced\(container, context\)/);
  assert.match(entry, /await installMainLayoutPolish\(container, context\)/);
});

test('weekly budget summary is compact and the accounts panel moves to the bottom', () => {
  assert.match(polish, /\['Budget-Konto', 'Direktausgaben', 'Auffüllbetrag'\]/);
  assert.match(polish, /banking-panel__description/);
  assert.match(polish, /runtime\.main\.append\(accounts\)/);
  assert.match(polish, /yuvomi:banking:accounts-open/);
  assert.match(style, /banking-weekly-budget--compact/);
});

test('transaction table consumes the full Yuvomi page-composition rail', () => {
  assert.match(entry, /ensureTableLayoutCompatStyles/);
  assert.match(entry, /table-layout-compat\.css/);
  assert.match(tableCompatStyle, /banking-transactions-table-wrap[\s\S]*inline-size:\s*100%\s*!important/);
  assert.match(tableCompatStyle, /banking-transactions-table[\s\S]*table-layout:\s*auto\s*!important/);
  assert.match(tableCompatStyle, /banking-transactions-table\s*>\s*colgroup[\s\S]*display:\s*none\s*!important/);
  assert.match(tableCompatStyle, /:nth-child\(2\)[\s\S]*width:\s*100%\s*!important/);
  assert.match(tableCompatStyle, /data-transaction-column\]\[hidden\][\s\S]*display:\s*none\s*!important/);
});

test('transaction table receives budget-week separators derived from the current period', () => {
  assert.match(polish, /weekly-budget\/current/);
  assert.match(polish, /data-budget-week-separator|budgetWeekSeparator/);
  assert.match(polish, /budgetWeekStart/);
  assert.match(polish, /Budgetwoche \$\{formatShortDate\(weekStart\)\}–\$\{formatShortDate\(weekEnd\)\}/);
  assert.match(style, /banking-budget-week-separator__content/);
  assert.match(style, /color-mix/);
});

test('main weekly-budget chart exposes every booked budget-account entry with an interactive tooltip', () => {
  assert.match(polish, /accounts\/\$\{encodeURIComponent\(accountId\)\}\/transactions/);
  assert.match(polish, /buildDetailedBudgetChartModel/);
  assert.match(polish, /banking-weekly-budget-chart__event/);
  assert.match(polish, /pointerenter/);
  assert.match(polish, /Stand danach:/);
  assert.match(polish, /transaction\?\.status !== 'BOOK'/);
  assert.match(style, /banking-weekly-budget-chart__tooltip/);
  assert.match(style, /data-direction="incoming"/);
  assert.match(style, /data-direction="outgoing"/);
});

test('detailed weekly-budget chart keeps same-day entries separate and reconstructs the running balance', async () => {
  const module = await import(pathToFileURL(path.join(moduleRoot, 'layout-polish.js')).href) as {
    buildDetailedBudgetChartModel: (current: unknown, transactions: unknown[]) => {
      availableCents: number;
      startBalanceCents: number;
      events: Array<{ signedCents: number; balanceCents: number; dayPosition: number; direction: string }>;
    } | null;
  };
  const model = module.buildDetailedBudgetChartModel({
    available_to_spend_cents: 4542,
    settings: { target_amount_cents: 45000 },
    period: { start_date: '2026-09-10', end_date: '2026-09-17' }
  }, [
    { id: 1, booking_date: '2026-09-10', amount: '450.00', direction: 'incoming', status: 'BOOK', counterparty_name: 'Refill' },
    { id: 2, booking_date: '2026-09-10', amount: '13.99', direction: 'outgoing', status: 'BOOK', merchant_name: 'Amazon' },
    { id: 3, booking_date: '2026-09-10', amount: '14.99', direction: 'outgoing', status: 'BOOK', merchant_name: 'PayPal' },
    { id: 4, booking_date: '2026-09-11', amount: '17.39', direction: 'outgoing', status: 'BOOK', counterparty_name: 'E-Kissel' },
    { id: 5, booking_date: '2026-09-11', amount: '99.00', direction: 'outgoing', status: 'PDNG', counterparty_name: 'Pending' }
  ]);
  assert.ok(model);
  assert.equal(model.availableCents, 4542);
  assert.equal(model.events.length, 4);
  assert.equal(model.events[0].signedCents, 45000);
  assert.equal(model.events[1].signedCents, -1399);
  assert.notEqual(model.events[0].dayPosition, model.events[1].dayPosition);
  assert.equal(model.events.at(-1)?.balanceCents, 4542);
  assert.equal(model.events[0].direction, 'incoming');
  assert.equal(model.events[1].direction, 'outgoing');
});

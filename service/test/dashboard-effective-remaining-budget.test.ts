import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const moduleRoot = resolve(process.cwd(), '../modules/banking');
const widgetPath = resolve(moduleRoot, 'widgets/weekly-budget-effective-remaining.js');

test('dashboard subtracts direct expenses from the budget-account balance', async () => {
  const widget = await import(pathToFileURL(widgetPath).href) as {
    calculateEffectiveRemainingBudget: (current: unknown) => number | null;
  };

  assert.equal(widget.calculateEffectiveRemainingBudget({
    available_to_spend_cents: 20866,
    direct_expense_cents: 13239
  }), 7627);
  assert.equal(widget.calculateEffectiveRemainingBudget({
    available_to_spend_cents: 5000,
    direct_expense_cents: 8000
  }), -3000);
});

test('calendar-week trend deducts direct expenses on the day they occurred', async () => {
  const widget = await import(pathToFileURL(widgetPath).href) as {
    buildEffectiveCalendarWeekTrendPoints: (
      current: unknown,
      transactions: unknown[],
      segments: unknown[]
    ) => Array<number | null>;
  };

  const current = {
    available_to_spend_cents: 20866,
    direct_expense_cents: 13239,
    direct_expenses: [
      { booking_date: '2026-09-13', amount_cents: 3239 },
      { booking_date: '2026-09-15', amount_cents: 5000 },
      { booking_date: '2026-09-17', amount_cents: 5000 }
    ]
  };
  const segments = [
    { date: '2026-09-14', state: 'past' },
    { date: '2026-09-15', state: 'past' },
    { date: '2026-09-16', state: 'past' },
    { date: '2026-09-17', state: 'current' },
    { date: '2026-09-18', state: 'future' },
    { date: '2026-09-19', state: 'future' },
    { date: '2026-09-20', state: 'future' }
  ];
  const transactions = [
    { booking_date: '2026-09-14', amount: '100.00', direction: 'outgoing' },
    { booking_date: '2026-09-15', amount: '50.00', direction: 'outgoing' },
    { booking_date: '2026-09-17', amount: '50.00', direction: 'outgoing' }
  ];

  assert.deepEqual(
    widget.buildEffectiveCalendarWeekTrendPoints(current, transactions, segments),
    [27627, 17627, 17627, 7627, null, null, null]
  );
});

test('weekly-budget manifest uses the effective-remaining widget layer', () => {
  const manifest = JSON.parse(readFileSync(resolve(moduleRoot, 'module.json'), 'utf8')) as {
    capabilities?: { widgets?: Array<{ id?: string; entry?: string }> };
  };
  const widget = manifest.capabilities?.widgets?.find((entry) => entry.id === 'weekly-budget');
  assert.equal(widget?.entry, 'widgets/weekly-budget-effective-remaining.js');
});

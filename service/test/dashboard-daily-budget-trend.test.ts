import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const widgetPath = resolve(process.cwd(), '../modules/banking/widgets/weekly-budget.js');
const widgetSource = readFileSync(widgetPath, 'utf8');
const widgetStyle = readFileSync(resolve(process.cwd(), '../modules/banking/widgets/weekly-budget.css'), 'utf8');

test('dashboard budget trend renders one passive marker per daily closing balance', () => {
  assert.match(widgetSource, /const dayDots = coordinates\.map/);
  assert.match(widgetSource, /banking-weekly-widget__sparkline-day-dot/);
  assert.match(widgetSource, /banking-weekly-widget__sparkline-guide/);
  assert.match(widgetSource, /svg\.append\(\.\.\.guides, area, line, \.\.\.dayDots\)/);
  assert.doesNotMatch(widgetSource.slice(widgetSource.indexOf('function renderSparkline'), widgetSource.indexOf('function formatTrendLabel')), /pointer|mouseenter|mouseover|mousemove|focus|click/i);
  assert.match(widgetStyle, /\.banking-weekly-widget__sparkline-day-dot\s*\{/);
  assert.match(widgetStyle, /\.banking-weekly-widget__sparkline-day-dot\[data-current="true"\]\s*\{/);
  assert.doesNotMatch(widgetStyle, /\.banking-weekly-widget__sparkline-day-dot:(?:hover|focus)/);
});

test('dashboard trend aggregates all intraday transactions into daily closing balances', async () => {
  const widget = await import(pathToFileURL(widgetPath).href) as {
    buildBudgetTrendPoints: (current: unknown, transactions: unknown[], now?: number | Date) => number[];
  };
  const current = {
    available_to_spend_cents: 35000,
    settings: { target_amount_cents: 45000, timezone: 'Europe/Berlin' },
    period: { start_date: '2026-09-10', end_date: '2026-09-17' }
  };
  const points = widget.buildBudgetTrendPoints(current, [
    { booking_date: '2026-09-10', amount: '20.00', direction: 'outgoing' },
    { booking_date: '2026-09-10', amount: '30.00', direction: 'outgoing' },
    { booking_date: '2026-09-11', amount: '10.00', direction: 'incoming' },
    { booking_date: '2026-09-11', amount: '5.00', direction: 'outgoing' }
  ], Date.parse('2026-09-11T18:00:00.000Z'));

  assert.equal(points.length, 2, 'two calendar days must produce exactly two chart states');
  assert.equal(points[0], 34500);
  assert.equal(points[1], 35000);
});

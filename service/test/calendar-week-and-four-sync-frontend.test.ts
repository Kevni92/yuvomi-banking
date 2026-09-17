import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const moduleRoot = resolve(process.cwd(), '../modules/banking');
const serviceRoot = process.cwd();

function moduleFile(path: string): string {
  return readFileSync(resolve(moduleRoot, path), 'utf8');
}

function serviceFile(path: string): string {
  return readFileSync(resolve(serviceRoot, path), 'utf8');
}

test('weekly-budget dashboard uses a fixed Monday-to-Sunday calendar week with wall-clock progress', async () => {
  const manifest = JSON.parse(moduleFile('module.json')) as {
    capabilities?: { widgets?: Array<{ id?: string; entry?: string }> };
  };
  const widget = manifest.capabilities?.widgets?.find((entry) => entry.id === 'weekly-budget');
  assert.equal(widget?.entry, 'widgets/weekly-budget-effective-remaining.js');

  const implementation = await import(pathToFileURL(
    resolve(moduleRoot, 'widgets/weekly-budget-calendar-week.js')
  ).href) as {
    calculateLocalDayProgress: (now: number | Date, timezone?: string) => number;
    buildCalendarWeekSegments: (input: Record<string, unknown>) => Array<{
      label: string;
      state: string;
      progress: number;
      cutoff: { ratio: number; time: string } | null;
    }>;
  };

  const noonBerlin = Date.parse('2026-09-17T10:00:00.000Z');
  assert.equal(implementation.calculateLocalDayProgress(noonBerlin, 'Europe/Berlin'), 0.5);

  const segments = implementation.buildCalendarWeekSegments({
    now: noonBerlin,
    timezone: 'Europe/Berlin',
    locale: 'de',
    cutoffWeekday: 7,
    cutoffTime: '20:00'
  });
  assert.deepEqual(segments.map((segment) => segment.label), ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']);
  assert.equal(segments[3].state, 'current');
  assert.equal(segments[3].progress, 0.5);
  assert.equal(segments[6].state, 'future');
  assert.equal(segments[6].progress, 0);
  assert.ok(Math.abs((segments[6].cutoff?.ratio ?? 0) - (20 / 24)) < 1e-12);
  assert.equal(segments[6].cutoff?.time, '20:00');

  const style = moduleFile('widgets/weekly-budget-calendar-week.css');
  assert.match(style, /--week-segment-progress/);
  assert.match(style, /--cutoff-position/);
  assert.match(style, /banking-weekly-widget__trend-labels/);
  assert.match(style, /banking-weekly-widget__sparkline-cutoff/);
});

test('Banking exposes and schedules four distinct daily background sync slots', () => {
  const migration = serviceFile('migrations/025_four_daily_account_sync_slots.sql');
  assert.match(migration, /sync_time_3/);
  assert.match(migration, /sync_time_4/);

  const scheduler = serviceFile('src/services/scheduled-account-sync-four-times.ts');
  for (const marker of ['sync_time_1', 'sync_time_2', 'sync_time_3', 'sync_time_4']) {
    assert.ok(scheduler.includes(marker), `Missing scheduler slot ${marker}`);
  }
  assert.match(scheduler, /latestDueDailySyncSlotFourTimes/);

  const schedulerEntry = serviceFile('src/services/weekly-budget-scheduler.ts');
  assert.match(schedulerEntry, /scheduled-account-sync-four-times\.js/);

  const routes = serviceFile('src/api/weekly-budget-sync-times-routes.ts');
  assert.match(routes, /new Set\(times\)\.size !== 4/);
  assert.match(routes, /weekly-budget\/sync-times/);

  const frontend = moduleFile('four-daily-sync-times.js');
  assert.match(frontend, /data-weekly-sync-three/);
  assert.match(frontend, /data-weekly-sync-four/);
  assert.match(frontend, /weekly-budget\/sync-times/);
});

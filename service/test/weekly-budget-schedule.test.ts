import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  assertTimeZone,
  localDateForInstant,
  weeklyBudgetCutoffSchedule,
  weeklyBudgetWindow
} from '../src/services/weekly-budget-schedule.js';

test('calculates the current Sunday-to-Sunday window in Europe/Berlin', () => {
  assert.deepEqual(weeklyBudgetWindow({
    now: new Date('2026-09-10T10:00:00Z'),
    cutoffWeekday: 7,
    cutoffTime: '18:30',
    timezone: 'Europe/Berlin',
    effectiveFromDate: '2026-01-01'
  }), {
    periodStartDate: '2026-09-06',
    periodEndDate: '2026-09-13',
    nextCutoffDate: '2026-09-13',
    nextCutoffAt: '2026-09-13T16:30:00.000Z'
  });
});

test('returns the immediately due cutoff as the previous cutoff', () => {
  const schedule = weeklyBudgetCutoffSchedule({
    now: new Date('2026-09-13T16:31:00.000Z'),
    cutoffWeekday: 7,
    cutoffTime: '18:30',
    timezone: 'Europe/Berlin'
  });
  assert.equal(schedule.previousCutoffDate, '2026-09-13');
  assert.equal(schedule.previousCutoffAt, '2026-09-13T16:30:00.000Z');
  assert.equal(schedule.nextCutoffAt, '2026-09-20T16:30:00.000Z');
});

test('starts a new window once the cutoff instant is reached', () => {
  const window = weeklyBudgetWindow({
    now: new Date('2026-09-13T16:30:00.000Z'),
    cutoffWeekday: 7,
    cutoffTime: '18:30',
    timezone: 'Europe/Berlin'
  });
  assert.equal(window.periodStartDate, '2026-09-13');
  assert.equal(window.periodEndDate, '2026-09-20');
});

test('moves a nonexistent spring DST cutoff to the next valid local minute', () => {
  const window = weeklyBudgetWindow({
    now: new Date('2026-03-28T12:00:00Z'),
    cutoffWeekday: 7,
    cutoffTime: '02:30',
    timezone: 'Europe/Berlin'
  });
  assert.equal(window.nextCutoffDate, '2026-03-29');
  assert.equal(window.nextCutoffAt, '2026-03-29T01:00:00.000Z');
});

test('chooses the first occurrence of a duplicate autumn DST cutoff', () => {
  const window = weeklyBudgetWindow({
    now: new Date('2026-10-24T12:00:00Z'),
    cutoffWeekday: 7,
    cutoffTime: '02:30',
    timezone: 'Europe/Berlin'
  });
  assert.equal(window.nextCutoffAt, '2026-10-25T00:30:00.000Z');
});

test('uses the activation date for the first shortened period', () => {
  const window = weeklyBudgetWindow({
    now: new Date('2026-09-10T10:00:00Z'),
    cutoffWeekday: 7,
    cutoffTime: '18:30',
    timezone: 'Europe/Berlin',
    effectiveFromDate: '2026-09-10'
  });
  assert.equal(window.periodStartDate, '2026-09-10');
});

test('validates IANA timezones and resolves the local calendar date', () => {
  assert.doesNotThrow(() => assertTimeZone('Europe/Berlin'));
  assert.throws(() => assertTimeZone('Not/A_Zone'), /valid IANA timezone/);
  assert.equal(
    localDateForInstant(new Date('2026-09-10T22:30:00Z'), 'Europe/Berlin'),
    '2026-09-11'
  );
});

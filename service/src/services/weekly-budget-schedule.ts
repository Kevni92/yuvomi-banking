export interface WeeklyBudgetWindowInput {
  now: Date;
  cutoffWeekday: number;
  cutoffTime: string;
  timezone: string;
  effectiveFromDate?: string | null;
}

export interface WeeklyBudgetWindow {
  periodStartDate: string;
  periodEndDate: string;
  nextCutoffDate: string;
  nextCutoffAt: string;
}

export interface WeeklyBudgetPeriodBoundary {
  periodStartDate: string;
  periodEndDate: string;
  scheduledCutoffAt: string;
}

export interface WeeklyBudgetCutoffSchedule {
  previousCutoffDate: string;
  previousCutoffAt: string;
  nextCutoffDate: string;
  nextCutoffAt: string;
}

interface LocalParts {
  date: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function weeklyBudgetWindow({
  now,
  cutoffWeekday,
  cutoffTime,
  timezone,
  effectiveFromDate
}: WeeklyBudgetWindowInput): WeeklyBudgetWindow {
  if (Number.isNaN(now.getTime())) throw new Error('Current time is invalid.');
  if (!Number.isSafeInteger(cutoffWeekday) || cutoffWeekday < 1 || cutoffWeekday > 7) {
    throw new Error('Cutoff weekday must be between 1 and 7.');
  }
  const { hour, minute } = parseLocalTime(cutoffTime);
  assertTimeZone(timezone);
  if (effectiveFromDate) assertIsoDate(effectiveFromDate, 'Effective-from date');

  const localNow = localPartsAt(now, timezone);
  const daysUntilCutoff = (cutoffWeekday - isoWeekday(localNow.date) + 7) % 7;
  let nextCutoffDate = addCalendarDays(localNow.date, daysUntilCutoff);
  let nextCutoff = localDateTimeToInstant(nextCutoffDate, hour, minute, timezone);
  if (nextCutoff.getTime() <= now.getTime()) {
    nextCutoffDate = addCalendarDays(nextCutoffDate, 7);
    nextCutoff = localDateTimeToInstant(nextCutoffDate, hour, minute, timezone);
  }

  const nominalStartDate = addCalendarDays(nextCutoffDate, -7);
  const periodStartDate = effectiveFromDate && effectiveFromDate > nominalStartDate
    ? effectiveFromDate
    : nominalStartDate;
  if (periodStartDate >= nextCutoffDate) {
    throw new Error('Effective-from date must be before the next cutoff.');
  }

  return {
    periodStartDate,
    periodEndDate: nextCutoffDate,
    nextCutoffDate,
    nextCutoffAt: nextCutoff.toISOString()
  };
}

export function localDateForInstant(instant: Date, timezone: string): string {
  if (Number.isNaN(instant.getTime())) throw new Error('Instant is invalid.');
  assertTimeZone(timezone);
  return localPartsAt(instant, timezone).date;
}

export function instantForLocalDateTime(
  date: string,
  time: string,
  timezone: string
): string {
  assertIsoDate(date, 'Local date');
  assertTimeZone(timezone);
  const { hour, minute } = parseLocalTime(time);
  return localDateTimeToInstant(date, hour, minute, timezone).toISOString();
}

export function weeklyBudgetCutoffSchedule({
  now,
  cutoffWeekday,
  cutoffTime,
  timezone
}: Omit<WeeklyBudgetWindowInput, 'effectiveFromDate'>): WeeklyBudgetCutoffSchedule {
  const window = weeklyBudgetWindow({
    now,
    cutoffWeekday,
    cutoffTime,
    timezone
  });
  const previousCutoffDate = addCalendarDays(window.nextCutoffDate, -7);
  const { hour, minute } = parseLocalTime(cutoffTime);
  return {
    previousCutoffDate,
    previousCutoffAt: localDateTimeToInstant(
      previousCutoffDate,
      hour,
      minute,
      timezone
    ).toISOString(),
    nextCutoffDate: window.nextCutoffDate,
    nextCutoffAt: window.nextCutoffAt
  };
}

export function weeklyBudgetPeriodEndingAt({
  scheduledCutoffAt,
  timezone,
  effectiveFromDate
}: {
  scheduledCutoffAt: Date;
  timezone: string;
  effectiveFromDate?: string | null;
}): WeeklyBudgetPeriodBoundary {
  if (Number.isNaN(scheduledCutoffAt.getTime())) {
    throw new Error('Scheduled cutoff is invalid.');
  }
  assertTimeZone(timezone);
  if (effectiveFromDate) assertIsoDate(effectiveFromDate, 'Effective-from date');
  const periodEndDate = localDateForInstant(scheduledCutoffAt, timezone);
  const nominalStartDate = addCalendarDays(periodEndDate, -7);
  const periodStartDate = effectiveFromDate && effectiveFromDate > nominalStartDate
    ? effectiveFromDate
    : nominalStartDate;
  if (periodStartDate >= periodEndDate) {
    throw new Error('Effective-from date must be before the cutoff period end.');
  }
  return {
    periodStartDate,
    periodEndDate,
    scheduledCutoffAt: scheduledCutoffAt.toISOString()
  };
}

export function assertTimeZone(timezone: string): void {
  if (!timezone.trim()) throw new Error('Timezone is required.');
  try {
    formatterFor(timezone);
  } catch {
    throw new Error('Timezone must be a valid IANA timezone.');
  }
}

function localDateTimeToInstant(
  date: string,
  hour: number,
  minute: number,
  timezone: string
): Date {
  const [year, month, day] = date.split('-').map(Number);
  const nominalUtc = Date.UTC(year, month - 1, day, hour, minute);
  const searchStart = nominalUtc - 18 * 60 * 60 * 1_000;
  const searchEnd = nominalUtc + 18 * 60 * 60 * 1_000;
  let nextValid: { wallMinute: number; instant: Date } | null = null;

  // Minute resolution matches the persisted HH:mm schedule. Scanning the
  // bounded timezone offset range also gives deterministic DST behavior:
  // first occurrence for duplicate times, next valid minute for gaps.
  for (let timestamp = searchStart; timestamp <= searchEnd; timestamp += 60_000) {
    const instant = new Date(timestamp);
    const local = localPartsAt(instant, timezone);
    if (local.date !== date) continue;
    if (local.hour === hour && local.minute === minute) return instant;

    const wallMinute = local.hour * 60 + local.minute;
    const requestedMinute = hour * 60 + minute;
    if (
      wallMinute > requestedMinute
      && (!nextValid || wallMinute < nextValid.wallMinute)
    ) {
      nextValid = { wallMinute, instant };
    }
  }

  if (nextValid) return nextValid.instant;
  throw new Error('Configured local cutoff cannot be resolved on that date.');
}

function localPartsAt(instant: Date, timezone: string): LocalParts {
  const values = new Map(
    formatterFor(timezone)
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  const year = Number(values.get('year'));
  const month = Number(values.get('month'));
  const day = Number(values.get('day'));
  const hour = Number(values.get('hour'));
  const minute = Number(values.get('minute'));
  if (![year, month, day, hour, minute].every(Number.isInteger)) {
    throw new Error('Timezone conversion failed.');
  }
  return {
    date: `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`,
    year,
    month,
    day,
    hour,
    minute
  };
}

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  // Some runtimes defer timezone validation until the first format call.
  formatter.format(new Date(0));
  formatterCache.set(timezone, formatter);
  return formatter;
}

function isoWeekday(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

export function addCalendarDays(date: string, days: number): string {
  assertIsoDate(date, 'Calendar date');
  const [year, month, day] = date.split('-').map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return `${result.getUTCFullYear().toString().padStart(4, '0')}-${(result.getUTCMonth() + 1).toString().padStart(2, '0')}-${result.getUTCDate().toString().padStart(2, '0')}`;
}

function parseLocalTime(value: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('Cutoff time must use HH:mm.');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error('Cutoff time is invalid.');
  return { hour, minute };
}

function assertIsoDate(value: string, label: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`${label} must use YYYY-MM-DD.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) throw new Error(`${label} is not a valid calendar date.`);
}

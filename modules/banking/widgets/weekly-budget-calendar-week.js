import { renderWidget as renderBaseWidget } from './weekly-budget.js';

const API_PREFIX = '/api/extensions/banking';
const STYLE_MARKER = 'banking-weekly-budget-calendar-week-style';
const SVG_NS = 'http://www.w3.org/2000/svg';

export async function renderWidget(container) {
  ensureStyles();
  await renderBaseWidget(container);

  const root = container.querySelector('.banking-weekly-widget');
  const content = root?.querySelector('.banking-weekly-widget__content');
  if (!root || !content || content.hidden) return;

  try {
    const response = await fetch(`${API_PREFIX}/weekly-budget/current`, {
      credentials: 'same-origin',
      cache: 'no-store'
    });
    if (!response.ok) return;
    const current = (await response.json())?.data;
    if (current?.configured !== true || current?.enabled === false) return;

    const now = Date.now();
    const timezone = current?.settings?.timezone || 'Europe/Berlin';
    const locale = document.documentElement.lang || 'de';
    const segments = buildCalendarWeekSegments({
      now,
      timezone,
      locale,
      cutoffWeekday: Number(current?.settings?.cutoff_weekday),
      cutoffTime: current?.settings?.cutoff_time
    });
    if (segments.length !== 7) return;

    renderCalendarWeek(root, segments);

    const transactions = await loadCalendarWeekTransactions(current, segments);
    const trendPoints = buildCalendarWeekTrendPoints(current, transactions, segments);
    renderCalendarWeekTrend(
      root.querySelector('.banking-weekly-widget__sparkline'),
      trendPoints,
      segments
    );
    renderTrendLabels(root, segments);
  } catch {
    // The stable base widget remains visible if the calendar-week enhancement fails.
  }
}

export function calculateLocalDayProgress(now = Date.now(), timezone = 'Europe/Berlin') {
  const date = now instanceof Date ? now : new Date(Number(now));
  if (Number.isNaN(date.getTime())) return 0;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const seconds = Number(values.hour) * 3600 + Number(values.minute) * 60 + Number(values.second);
    return clamp(seconds / 86400, 0, 1);
  } catch {
    const seconds = date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds();
    return clamp(seconds / 86400, 0, 1);
  }
}

export function buildCalendarWeekSegments({
  now = Date.now(),
  timezone = 'Europe/Berlin',
  locale = 'de',
  cutoffWeekday = 7,
  cutoffTime = '20:00'
} = {}) {
  const today = localIsoDate(now, timezone);
  if (!today) return [];
  const todayWeekday = isoWeekday(today);
  const monday = addIsoDays(today, -(todayWeekday - 1));
  const german = String(locale).toLowerCase().startsWith('de');
  const labels = german
    ? ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
    : ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  const currentProgress = calculateLocalDayProgress(now, timezone);
  const cutoffRatio = timeRatio(cutoffTime);

  return Array.from({ length: 7 }, (_, index) => {
    const date = addIsoDays(monday, index);
    const state = date < today ? 'past' : date === today ? 'current' : 'future';
    const weekday = index + 1;
    return {
      date,
      label: labels[index],
      weekday,
      state,
      progress: state === 'past' ? 1 : state === 'current' ? currentProgress : 0,
      cutoff: weekday === cutoffWeekday && cutoffRatio !== null
        ? { ratio: cutoffRatio, time: String(cutoffTime) }
        : null
    };
  });
}

export function buildCalendarWeekTrendPoints(current, transactions, segments) {
  const available = safeCents(current?.available_to_spend_cents);
  if (available === null || !Array.isArray(segments) || segments.length !== 7) {
    return Array(7).fill(null);
  }

  const segmentDates = new Set(segments.map((segment) => segment.date));
  const netByDate = new Map();
  for (const transaction of Array.isArray(transactions) ? transactions : []) {
    const date = transaction?.booking_date ?? transaction?.value_date ?? transaction?.transaction_date;
    if (typeof date !== 'string' || !segmentDates.has(date)) continue;
    const amountCents = majorAmountToCents(transaction?.amount);
    if (amountCents === null) continue;
    const signed = transaction?.direction === 'incoming' ? amountCents : -amountCents;
    netByDate.set(date, (netByDate.get(date) ?? 0) + signed);
  }

  const visibleSegments = segments.filter((segment) => segment.state !== 'future');
  const visibleNet = visibleSegments.reduce((sum, segment) => sum + (netByDate.get(segment.date) ?? 0), 0);
  let balance = available - visibleNet;
  const points = [];
  for (const segment of segments) {
    if (segment.state === 'future') {
      points.push(null);
      continue;
    }
    balance += netByDate.get(segment.date) ?? 0;
    points.push(balance);
  }
  const currentIndex = segments.findIndex((segment) => segment.state === 'current');
  if (currentIndex >= 0) points[currentIndex] = available;
  return points;
}

function ensureStyles() {
  if (document.head.querySelector(`link[data-widget-style="${STYLE_MARKER}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./weekly-budget-calendar-week.css', import.meta.url).href;
  link.dataset.widgetStyle = STYLE_MARKER;
  document.head.append(link);
}

async function loadCalendarWeekTransactions(current, segments) {
  const accountId = Number(current?.settings?.target_account?.id);
  if (!Number.isSafeInteger(accountId) || accountId < 1) return [];
  const visible = segments.filter((segment) => segment.state !== 'future');
  if (!visible.length) return [];
  const dateFrom = segments[0].date;
  const dateTo = visible.at(-1).date;
  const transactions = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const params = new URLSearchParams({
      account_id: String(accountId),
      status: 'BOOK',
      date_from: dateFrom,
      date_to: dateTo,
      sort: 'date',
      order: 'asc',
      limit: String(limit),
      offset: String(offset)
    });
    const response = await fetch(`${API_PREFIX}/transactions?${params}`, {
      credentials: 'same-origin',
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json())?.data;
    const page = Array.isArray(data?.transactions) ? data.transactions : [];
    transactions.push(...page);
    const total = Number(data?.pagination?.total ?? page.length);
    offset += page.length;
    if (page.length === 0 || offset >= total || page.length < limit) break;
  }
  return transactions;
}

function renderCalendarWeek(root, segments) {
  const progress = root.querySelector('.banking-weekly-widget__week-progress');
  const labels = root.querySelector('.banking-weekly-widget__week-labels');
  const summary = root.querySelector('.banking-weekly-widget__week-summary');
  if (!progress || !labels) return;

  progress.replaceChildren();
  labels.replaceChildren();
  let elapsed = 0;
  let reachedDays = 0;

  for (const segment of segments) {
    elapsed += segment.progress;
    if (segment.state !== 'future') reachedDays += 1;

    const item = document.createElement('span');
    item.className = 'banking-weekly-widget__week-segment';
    item.dataset.state = segment.state;
    item.style.setProperty('--week-segment-progress', `${clamp(segment.progress, 0, 1) * 100}%`);

    const fill = document.createElement('span');
    fill.className = 'banking-weekly-widget__week-segment-fill';
    item.append(fill);

    if (segment.cutoff) {
      const marker = document.createElement('span');
      marker.className = 'banking-weekly-widget__cutoff-marker';
      marker.style.setProperty('--cutoff-position', `${segment.cutoff.ratio * 100}%`);
      marker.setAttribute('aria-label', `Stichtag ${segment.cutoff.time}`);
      const markerLabel = document.createElement('span');
      markerLabel.className = 'banking-weekly-widget__cutoff-label';
      markerLabel.textContent = segment.cutoff.time;
      marker.append(markerLabel);
      item.append(marker);
    }
    progress.append(item);

    const label = document.createElement('span');
    label.textContent = segment.label;
    label.dataset.state = segment.state;
    labels.append(label);
  }

  progress.setAttribute('aria-valuenow', String(Math.round(elapsed * 10000) / 10000));
  if (summary) {
    const german = String(document.documentElement.lang || 'de').toLowerCase().startsWith('de');
    summary.textContent = german ? `${reachedDays} von 7 Tagen` : `${reachedDays} of 7 days`;
  }
}

function renderTrendLabels(root, segments) {
  const trend = root.querySelector('.banking-weekly-widget__trend');
  const svg = root.querySelector('.banking-weekly-widget__sparkline');
  if (!trend || !svg) return;
  let labels = trend.querySelector('.banking-weekly-widget__trend-labels');
  if (!labels) {
    labels = document.createElement('div');
    labels.className = 'banking-weekly-widget__trend-labels';
    svg.after(labels);
  }
  labels.replaceChildren();
  for (const segment of segments) {
    const item = document.createElement('span');
    item.textContent = segment.label;
    item.dataset.state = segment.state;
    labels.append(item);
  }
}

function renderCalendarWeekTrend(svg, values, segments) {
  if (!(svg instanceof SVGElement)) return;
  svg.replaceChildren();
  svg.setAttribute('viewBox', '0 0 240 64');
  const width = 240;
  const height = 64;
  const padX = 5;
  const padY = 5;
  const numeric = values.map((value) => Number.isFinite(Number(value)) ? Number(value) : null);
  const finite = numeric.filter((value) => value !== null);
  if (!finite.length) return;
  const max = Math.max(...finite, 1);
  const min = Math.min(...finite, 0);
  const span = Math.max(1, max - min);
  const xFor = (index) => padX + (index / 6) * (width - padX * 2);
  const yFor = (value) => padY + ((max - value) / span) * (height - padY * 2);

  for (let index = 0; index < 7; index += 1) {
    const guide = document.createElementNS(SVG_NS, 'line');
    guide.classList.add('banking-weekly-widget__sparkline-guide');
    const x = xFor(index);
    guide.setAttribute('x1', String(x));
    guide.setAttribute('x2', String(x));
    guide.setAttribute('y1', '2');
    guide.setAttribute('y2', String(height - 2));
    svg.append(guide);
  }

  const cutoffSegmentIndex = segments.findIndex((segment) => segment.cutoff);
  if (cutoffSegmentIndex >= 0) {
    const ratio = segments[cutoffSegmentIndex].cutoff.ratio;
    const dayWidth = (width - padX * 2) / 7;
    const cutoffX = padX + (cutoffSegmentIndex + ratio) * dayWidth;
    const cutoff = document.createElementNS(SVG_NS, 'line');
    cutoff.classList.add('banking-weekly-widget__sparkline-cutoff');
    cutoff.setAttribute('x1', String(cutoffX));
    cutoff.setAttribute('x2', String(cutoffX));
    cutoff.setAttribute('y1', String(height * 0.62));
    cutoff.setAttribute('y2', String(height - 2));
    svg.append(cutoff);
  }

  const points = numeric.map((value, index) => value === null ? null : {
    index,
    value,
    x: xFor(index),
    y: yFor(value)
  });
  const visible = points.filter(Boolean);
  if (visible.length >= 2) {
    const line = document.createElementNS(SVG_NS, 'path');
    line.classList.add('banking-weekly-widget__sparkline-line');
    line.setAttribute('d', visible.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' '));
    svg.append(line);

    const area = document.createElementNS(SVG_NS, 'path');
    area.classList.add('banking-weekly-widget__sparkline-area');
    const first = visible[0];
    const last = visible.at(-1);
    area.setAttribute('d', `${visible.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')} L ${last.x} ${height - 2} L ${first.x} ${height - 2} Z`);
    svg.insertBefore(area, line);
  }

  for (const point of visible) {
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.classList.add('banking-weekly-widget__sparkline-day-dot');
    dot.dataset.current = segments[point.index]?.state === 'current' ? 'true' : 'false';
    dot.setAttribute('cx', String(point.x));
    dot.setAttribute('cy', String(point.y));
    dot.setAttribute('r', '2.7');
    svg.append(dot);
  }
}

function localIsoDate(now, timezone) {
  const date = now instanceof Date ? now : new Date(Number(now));
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function isoWeekday(date) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

function addIsoDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(value.getTime())) return date;
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function timeRatio(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return (hours * 60 + minutes) / (24 * 60);
}

function safeCents(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function majorAmountToCents(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const cents = Math.round(number * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value)));
}

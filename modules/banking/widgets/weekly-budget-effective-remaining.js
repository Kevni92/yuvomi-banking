import {
  renderWidget as renderCalendarWeekWidget,
  buildCalendarWeekSegments,
  buildCalendarWeekTrendPoints
} from './weekly-budget-calendar-week.js';
import {
  budgetColorForRatio,
  calculateBudgetTrendState,
  calculateRemainingWeeklyBudgetProgress
} from './weekly-budget.js';

const API_PREFIX = '/api/extensions/banking';
const SVG_NS = 'http://www.w3.org/2000/svg';

export async function renderWidget(container) {
  await renderCalendarWeekWidget(container);

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
    applyEffectiveBudgetSummary(root, current, now);

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

    const transactions = await loadCalendarWeekTransactions(current, segments);
    const effectiveCurrent = {
      ...current,
      available_to_spend_cents: calculateEffectiveRemainingBudget(current)
    };
    const trendTransactions = [
      ...transactions,
      ...directExpensesAsSyntheticTransactions(current)
    ];
    const trendPoints = buildCalendarWeekTrendPoints(
      effectiveCurrent,
      trendTransactions,
      segments
    );
    renderCalendarWeekTrend(
      root.querySelector('.banking-weekly-widget__sparkline'),
      trendPoints,
      segments
    );
  } catch {
    // Keep the already rendered calendar-week widget usable when this enhancement fails.
  }
}

export function calculateEffectiveRemainingBudget(current) {
  const balance = safeCents(current?.available_to_spend_cents);
  const directExpenses = safeCents(current?.direct_expense_cents);
  if (balance === null) return null;
  return balance - (directExpenses ?? 0);
}

export function buildEffectiveCalendarWeekTrendPoints(current, transactions, segments) {
  const remaining = calculateEffectiveRemainingBudget(current);
  if (remaining === null) return Array(7).fill(null);
  return buildCalendarWeekTrendPoints(
    { ...current, available_to_spend_cents: remaining },
    [
      ...(Array.isArray(transactions) ? transactions : []),
      ...directExpensesAsSyntheticTransactions(current)
    ],
    segments
  );
}

function applyEffectiveBudgetSummary(root, current, now) {
  const remaining = calculateEffectiveRemainingBudget(current);
  const target = safeCents(current?.settings?.target_amount_cents);
  if (remaining === null || target === null || target <= 0) return;

  const amount = root.querySelector('.banking-weekly-widget__amount');
  const progress = root.querySelector('.banking-weekly-widget__budget-progress');
  const fill = root.querySelector('.banking-weekly-widget__budget-progress-fill');
  const percent = root.querySelector('.banking-weekly-widget__budget-percent');
  const badge = root.querySelector('.banking-weekly-widget__trend-badge');

  if (amount) amount.textContent = formatCents(remaining);

  const ratio = clamp(remaining / target, 0, 1);
  const percentage = Math.round(ratio * 100);
  root.style.setProperty('--budget-progress-color', budgetColorForRatio(ratio));
  progress?.setAttribute('aria-valuenow', String(percentage));
  if (fill) fill.style.width = `${percentage}%`;
  if (percent) percent.textContent = `${percentage} %`;

  const remainingWeekRatio = calculateRemainingWeeklyBudgetProgress(
    current?.period?.next_cutoff_at,
    now
  );
  const trendState = calculateBudgetTrendState(ratio, remainingWeekRatio);
  root.dataset.trend = trendState;
  if (badge) badge.textContent = formatTrendLabel(trendState, document.documentElement.lang);
}

function directExpensesAsSyntheticTransactions(current) {
  const directExpenses = Array.isArray(current?.direct_expenses)
    ? current.direct_expenses
    : [];
  return directExpenses.flatMap((expense) => {
    const cents = safeCents(expense?.amount_cents);
    const date = expense?.booking_date;
    if (cents === null || cents < 0 || typeof date !== 'string') return [];
    return [{
      booking_date: date,
      amount: (cents / 100).toFixed(2),
      direction: 'outgoing'
    }];
  });
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

function formatTrendLabel(state, locale) {
  const german = String(locale).toLowerCase().startsWith('de');
  if (state === 'under') return german ? '↓ unter Plan' : '↓ under plan';
  if (state === 'over') return german ? '↑ über Plan' : '↑ over plan';
  if (state === 'on') return german ? '● im Plan' : '● on plan';
  return german ? '– kein Trend' : '– no trend';
}

function safeCents(value) {
  const cents = Number(value);
  return Number.isSafeInteger(cents) ? cents : null;
}

function formatCents(value) {
  const cents = Number(value);
  if (!Number.isSafeInteger(cents)) return '–';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'EUR'
  }).format(cents / 100);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value)));
}

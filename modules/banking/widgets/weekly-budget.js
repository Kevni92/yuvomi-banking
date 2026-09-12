const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const WIDGET_STYLE_MARKER = 'banking-weekly-budget-widget-style';
const SVG_NS = 'http:' + '//www.w3.org/2000/svg';

function ensureWidgetStyles() {
  if (typeof document === 'undefined' || !document.head) return;
  if (document.head.querySelector(`link[data-widget-style="${WIDGET_STYLE_MARKER}"]`)) return;

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./weekly-budget.css', import.meta.url).href;
  link.dataset.widgetStyle = WIDGET_STYLE_MARKER;
  document.head.append(link);
}

export async function renderWidget(container) {
  ensureWidgetStyles();
  container.replaceChildren();

  const wrapper = document.createElement('a');
  wrapper.className = 'banking-weekly-widget';
  wrapper.href = '/m/banking';
  wrapper.dataset.route = '/m/banking';
  wrapper.setAttribute('aria-label', message('Banking öffnen', 'Open Banking'));
  wrapper.setAttribute('aria-busy', 'true');

  const header = document.createElement('div');
  header.className = 'banking-weekly-widget__header';

  const title = document.createElement('strong');
  title.className = 'banking-weekly-widget__title';
  title.textContent = message('Wochenbudget', 'Weekly budget');

  const wallet = document.createElement('span');
  wallet.className = 'banking-weekly-widget__wallet';
  wallet.setAttribute('aria-hidden', 'true');
  appendWalletIcon(wallet);
  header.append(title, wallet);

  const state = document.createElement('p');
  state.className = 'banking-weekly-widget__state';
  state.textContent = message('Wird geladen …', 'Loading ...');

  const content = document.createElement('div');
  content.className = 'banking-weekly-widget__content';
  content.hidden = true;

  const amount = document.createElement('strong');
  amount.className = 'banking-weekly-widget__amount';

  const baseline = document.createElement('span');
  baseline.className = 'banking-weekly-widget__baseline';

  const budgetProgressRow = document.createElement('div');
  budgetProgressRow.className = 'banking-weekly-widget__budget-progress-row';

  const budgetProgress = document.createElement('div');
  budgetProgress.className = 'banking-weekly-widget__budget-progress';
  budgetProgress.setAttribute('role', 'progressbar');
  budgetProgress.setAttribute('aria-label', message(
    'Verbleibendes Wochenbudget',
    'Remaining weekly budget'
  ));
  budgetProgress.setAttribute('aria-valuemin', '0');
  budgetProgress.setAttribute('aria-valuemax', '100');

  const budgetProgressFill = document.createElement('span');
  budgetProgressFill.className = 'banking-weekly-widget__budget-progress-fill';
  budgetProgress.append(budgetProgressFill);

  const budgetPercent = document.createElement('strong');
  budgetPercent.className = 'banking-weekly-widget__budget-percent';
  budgetProgressRow.append(budgetProgress, budgetPercent);

  const trend = document.createElement('section');
  trend.className = 'banking-weekly-widget__trend';

  const trendHeader = document.createElement('div');
  trendHeader.className = 'banking-weekly-widget__section-header';
  const trendTitle = document.createElement('strong');
  trendTitle.textContent = message('Budgettrend', 'Budget trend');
  const trendBadge = document.createElement('span');
  trendBadge.className = 'banking-weekly-widget__trend-badge';
  trendHeader.append(trendTitle, trendBadge);

  const sparkline = document.createElementNS(SVG_NS, 'svg');
  sparkline.classList.add('banking-weekly-widget__sparkline');
  sparkline.setAttribute('viewBox', '0 0 240 64');
  sparkline.setAttribute('preserveAspectRatio', 'none');
  sparkline.setAttribute('aria-hidden', 'true');
  trend.append(trendHeader, sparkline);

  const week = document.createElement('section');
  week.className = 'banking-weekly-widget__week';

  const weekHeader = document.createElement('div');
  weekHeader.className = 'banking-weekly-widget__section-header';
  const weekTitle = document.createElement('strong');
  weekTitle.textContent = message('Woche', 'Week');
  const weekSummary = document.createElement('span');
  weekSummary.className = 'banking-weekly-widget__week-summary';
  weekHeader.append(weekTitle, weekSummary);

  const weekProgress = document.createElement('div');
  weekProgress.className = 'banking-weekly-widget__week-progress';
  weekProgress.setAttribute('role', 'progressbar');
  weekProgress.setAttribute('aria-label', message('Fortschritt der Budgetwoche', 'Budget week progress'));
  weekProgress.setAttribute('aria-valuemin', '0');
  weekProgress.setAttribute('aria-valuemax', '7');

  const weekLabels = document.createElement('div');
  weekLabels.className = 'banking-weekly-widget__week-labels';
  week.append(weekHeader, weekProgress, weekLabels);

  content.append(amount, baseline, budgetProgressRow, trend, week);
  wrapper.append(header, state, content);
  container.append(wrapper);

  try {
    const response = await fetch('/api/extensions/banking/weekly-budget/current', {
      credentials: 'same-origin',
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const current = (await response.json())?.data;

    if (current?.configured !== true) {
      state.textContent = message('Noch nicht eingerichtet.', 'Not configured yet.');
      return;
    }
    if (current?.enabled === false) {
      state.textContent = message('Aktuell deaktiviert.', 'Currently disabled.');
      return;
    }

    const availableCents = safeCents(current?.available_to_spend_cents);
    const targetCents = safeCents(current?.settings?.target_amount_cents);
    if (availableCents === null || targetCents === null || targetCents <= 0) {
      state.textContent = message('Budgetdaten nicht verfügbar.', 'Budget data unavailable.');
      return;
    }

    state.hidden = true;
    content.hidden = false;

    amount.textContent = formatCents(availableCents);
    baseline.textContent = message(
      `von ${formatCents(targetCents)}`,
      `of ${formatCents(targetCents)}`
    );

    const budgetRatio = clamp(availableCents / targetCents, 0, 1);
    const budgetPercentage = Math.round(budgetRatio * 100);
    const budgetColor = budgetColorForRatio(budgetRatio);
    wrapper.style.setProperty('--budget-progress-color', budgetColor);
    budgetProgress.setAttribute('aria-valuenow', String(budgetPercentage));
    budgetProgressFill.style.width = `${budgetPercentage}%`;
    budgetPercent.textContent = `${budgetPercentage} %`;

    const remainingWeekRatio = calculateRemainingWeeklyBudgetProgress(
      current?.period?.next_cutoff_at,
      Date.now()
    );
    const trendState = calculateBudgetTrendState(budgetRatio, remainingWeekRatio);
    wrapper.dataset.trend = trendState;
    trendBadge.textContent = formatTrendLabel(trendState, document.documentElement.lang);

    let trendTransactions = [];
    try {
      trendTransactions = await loadBudgetAccountTransactions(current);
    } catch {
      // The widget remains useful when the optional trend-history request fails.
    }
    const trendPoints = buildBudgetTrendPoints(current, trendTransactions, Date.now());
    renderSparkline(sparkline, trendPoints);

    const segments = buildBudgetWeekSegments(
      current?.period?.end_date,
      Date.now(),
      current?.settings?.timezone,
      document.documentElement.lang
    );
    renderWeekProgress(weekProgress, weekLabels, segments);
    const completedDays = segments.filter((segment) => segment.state !== 'future').length;
    weekProgress.setAttribute('aria-valuenow', String(completedDays));
    weekSummary.textContent = message(
      `${completedDays} von 7 Tagen`,
      `${completedDays} of 7 days`
    );
  } catch {
    state.hidden = false;
    content.hidden = true;
    state.textContent = message('Wochenbudget nicht verfügbar.', 'Weekly budget unavailable.');
  } finally {
    wrapper.removeAttribute('aria-busy');
  }
}

async function loadBudgetAccountTransactions(current) {
  const accountId = Number(current?.settings?.target_account?.id);
  const dateFrom = current?.period?.start_date;
  const dateTo = previousIsoDate(current?.period?.end_date);
  if (!Number.isSafeInteger(accountId) || accountId < 1 || !dateFrom || !dateTo) return [];

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
    const response = await fetch(`/api/extensions/banking/transactions?${params}`, {
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

export function calculateRemainingWeeklyBudgetProgress(nextCutoffAt, now = Date.now()) {
  const cutoffMs = nextCutoffAt instanceof Date
    ? nextCutoffAt.getTime()
    : typeof nextCutoffAt === 'string'
      ? Date.parse(nextCutoffAt)
      : Number.NaN;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(cutoffMs) || !Number.isFinite(nowMs)) return null;
  return Math.min(1, Math.max(0, (cutoffMs - nowMs) / WEEK_MS));
}

export function calculateRemainingWeeklyBudgetDays(nextCutoffAt, now = Date.now()) {
  const cutoffMs = nextCutoffAt instanceof Date
    ? nextCutoffAt.getTime()
    : typeof nextCutoffAt === 'string'
      ? Date.parse(nextCutoffAt)
      : Number.NaN;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(cutoffMs) || !Number.isFinite(nowMs)) return null;
  return Math.max(0, Math.ceil((cutoffMs - nowMs) / DAY_MS));
}

export function calculateBudgetTrendState(budgetRatio, remainingWeekRatio, tolerance = 0.08) {
  if (!Number.isFinite(budgetRatio) || !Number.isFinite(remainingWeekRatio)) return 'neutral';
  const difference = budgetRatio - remainingWeekRatio;
  if (difference < -tolerance) return 'under';
  if (difference > tolerance) return 'over';
  return 'on';
}

export function buildBudgetWeekSegments(periodEndDate, now = Date.now(), timezone = 'Europe/Berlin', locale = 'de') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(periodEndDate ?? ''))) return [];
  const weekStart = addIsoDays(periodEndDate, -7);
  const today = localIsoDate(now, timezone);
  const german = String(locale).toLowerCase().startsWith('de');
  const labels = german
    ? ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']
    : ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  return Array.from({ length: 7 }, (_, index) => {
    const date = addIsoDays(weekStart, index);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    return {
      date,
      label: labels[weekday],
      state: date < today ? 'past' : date === today ? 'current' : 'future'
    };
  });
}

export function buildBudgetTrendPoints(current, transactions, now = Date.now()) {
  const available = safeCents(current?.available_to_spend_cents);
  const target = safeCents(current?.settings?.target_amount_cents);
  const startDate = current?.period?.start_date;
  const endDate = current?.period?.end_date;
  const timezone = current?.settings?.timezone ?? 'Europe/Berlin';
  if (available === null || target === null || !startDate || !endDate) return [];

  const today = localIsoDate(now, timezone);
  const lastDate = today < endDate ? today : previousIsoDate(endDate);
  if (!lastDate || lastDate < startDate) return [target, available];

  const netByDate = new Map();
  for (const transaction of Array.isArray(transactions) ? transactions : []) {
    const date = transaction?.booking_date ?? transaction?.value_date ?? transaction?.transaction_date;
    if (typeof date !== 'string' || date < startDate || date > lastDate) continue;
    const amountCents = majorAmountToCents(transaction?.amount);
    if (amountCents === null) continue;
    const signed = transaction?.direction === 'incoming' ? amountCents : -amountCents;
    netByDate.set(date, (netByDate.get(date) ?? 0) + signed);
  }

  const days = [];
  for (let date = startDate; date <= lastDate; date = addIsoDays(date, 1)) days.push(date);
  const totalNet = days.reduce((sum, date) => sum + (netByDate.get(date) ?? 0), 0);
  let balance = available - totalNet;
  const points = [];
  for (const date of days) {
    balance += netByDate.get(date) ?? 0;
    points.push(balance);
  }
  if (points.length === 0) return [target, available];
  points[points.length - 1] = available;
  return points.length === 1 ? [target, points[0]] : points;
}

export function budgetColorForRatio(ratio) {
  const normalized = clamp(Number(ratio), 0, 1);
  const hue = Math.round(normalized * 120);
  return `hsl(${hue} 84% 61%)`;
}

export function formatRemainingWeeklyBudget(nextCutoffAt, now = Date.now(), locale = 'de') {
  const days = calculateRemainingWeeklyBudgetDays(nextCutoffAt, now);
  const german = String(locale).toLowerCase().startsWith('de');
  if (days === null) return german ? 'Zeitraum nicht verfügbar' : 'Period unavailable.';
  if (days === 0) return german ? 'noch heute' : 'ends today';
  if (german) return days === 1 ? 'noch 1 Tag' : `noch ${days} Tage`;
  return days === 1 ? '1 day left' : `${days} days left`;
}

function renderWeekProgress(progress, labels, segments) {
  progress.replaceChildren();
  labels.replaceChildren();
  for (const segment of segments) {
    const item = document.createElement('span');
    item.className = 'banking-weekly-widget__week-segment';
    item.dataset.state = segment.state;
    progress.append(item);

    const label = document.createElement('span');
    label.textContent = segment.label;
    label.dataset.state = segment.state;
    labels.append(label);
  }
}

function renderSparkline(svg, values) {
  svg.replaceChildren();
  const points = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite);
  if (points.length < 2) return;

  const width = 240;
  const height = 64;
  const pad = 4;
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const span = Math.max(1, max - min);
  const coordinates = points.map((value, index) => {
    const x = pad + (index / Math.max(1, points.length - 1)) * (width - pad * 2);
    const y = pad + ((max - value) / span) * (height - pad * 2 - 8);
    return [x, y];
  });

  const guides = coordinates.map(([x]) => {
    const guide = document.createElementNS(SVG_NS, 'line');
    guide.setAttribute('x1', String(x));
    guide.setAttribute('x2', String(x));
    guide.setAttribute('y1', String(pad));
    guide.setAttribute('y2', String(height - pad));
    guide.setAttribute('class', 'banking-weekly-widget__sparkline-guide');
    return guide;
  });

  const area = document.createElementNS(SVG_NS, 'path');
  const line = document.createElementNS(SVG_NS, 'polyline');
  const areaPath = [
    `M ${coordinates[0][0]} ${height - pad}`,
    ...coordinates.map(([x, y]) => `L ${x} ${y}`),
    `L ${coordinates[coordinates.length - 1][0]} ${height - pad}`,
    'Z'
  ].join(' ');
  area.setAttribute('d', areaPath);
  area.setAttribute('class', 'banking-weekly-widget__sparkline-area');
  line.setAttribute('points', coordinates.map(([x, y]) => `${x},${y}`).join(' '));
  line.setAttribute('class', 'banking-weekly-widget__sparkline-line');

  const dayDots = coordinates.map(([x, y], index) => {
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', String(x));
    dot.setAttribute('cy', String(y));
    dot.setAttribute('r', index === coordinates.length - 1 ? '3.5' : '2.6');
    dot.setAttribute('class', 'banking-weekly-widget__sparkline-day-dot');
    if (index === coordinates.length - 1) dot.dataset.current = 'true';
    return dot;
  });

  svg.append(...guides, area, line, ...dayDots);
}

function formatTrendLabel(state, locale) {
  const german = String(locale).toLowerCase().startsWith('de');
  if (state === 'under') return german ? '↓ unter Plan' : '↓ under plan';
  if (state === 'over') return german ? '↑ über Plan' : '↑ over plan';
  if (state === 'on') return german ? '● im Plan' : '● on plan';
  return german ? '– kein Trend' : '– no trend';
}

function appendWalletIcon(host) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const body = document.createElementNS(SVG_NS, 'path');
  body.setAttribute('d', 'M4 7.5h13.5A2.5 2.5 0 0 1 20 10v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 2 17V7a2.5 2.5 0 0 1 2.5-2.5H16');
  const flap = document.createElementNS(SVG_NS, 'path');
  flap.setAttribute('d', 'M15.5 11.5H21v4h-5.5a2 2 0 1 1 0-4Z');
  svg.append(body, flap);
  host.append(svg);
}

function safeCents(value) {
  const cents = Number(value);
  return Number.isSafeInteger(cents) ? cents : null;
}

function majorAmountToCents(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const cents = Math.round(numeric * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

function localIsoDate(now, timezone) {
  const date = now instanceof Date ? now : new Date(Number(now));
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: typeof timezone === 'string' && timezone ? timezone : 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function addIsoDays(date, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) return '';
  const [year, month, day] = date.split('-').map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return `${result.getUTCFullYear().toString().padStart(4, '0')}-${(result.getUTCMonth() + 1).toString().padStart(2, '0')}-${result.getUTCDate().toString().padStart(2, '0')}`;
}

function previousIsoDate(date) {
  return addIsoDays(date, -1);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatCents(value) {
  const cents = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isSafeInteger(cents)) return '–';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'EUR'
  }).format(cents / 100);
}

function message(german, english) {
  return document.documentElement.lang?.toLowerCase().startsWith('de') ? german : english;
}
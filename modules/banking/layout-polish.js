const API_PREFIX = '/api/extensions/banking';
const STYLE_ID = 'banking-main-layout-polish';
const DAY_MS = 86_400_000;
const SVG_NS = 'http:' + '//www.w3.org/2000/svg';

export async function installMainLayoutPolish(container, context = {}) {
  const main = container.querySelector('[data-banking-main-content]');
  if (!main) return;

  ensureStyles();
  const runtime = {
    container,
    main,
    signal: context?.signal,
    weeklyBudget: null,
    budgetTransactions: [],
    scheduled: false,
    tableSignature: '',
    chartSignature: ''
  };

  moveAccountsToBottom(runtime);
  collapseAccountsByDefault(runtime);
  simplifyWeeklyBudget(runtime);
  await refreshWeeklyBudgetContext(runtime);
  if (runtime.signal?.aborted) return;
  applyPolish(runtime);

  const observer = new MutationObserver((records) => {
    if (!records.some((record) => hasRelevantMutation(record))) return;
    schedulePolish(runtime);
  });
  observer.observe(main, { childList: true, subtree: true });
  runtime.signal?.addEventListener('abort', () => observer.disconnect(), { once: true });

  const reload = main.querySelector('[data-action="reload-weekly-budget"]');
  reload?.addEventListener('click', () => {
    window.setTimeout(() => { void refreshWeeklyBudgetContext(runtime); }, 150);
  }, { signal: runtime.signal });
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const link = document.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.href = new URL('./layout-polish.css', import.meta.url).href;
  document.head.appendChild(link);
}

async function refreshWeeklyBudgetContext(runtime) {
  try {
    const response = await fetch(`${API_PREFIX}/weekly-budget/current`, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: runtime.signal
    });
    if (!response.ok) return;
    const payload = await response.json();
    runtime.weeklyBudget = payload?.data ?? null;
    runtime.tableSignature = '';
    runtime.chartSignature = '';
    try {
      runtime.budgetTransactions = await loadBudgetAccountTransactions(runtime.weeklyBudget, runtime.signal);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      runtime.budgetTransactions = [];
    }
    applyPolish(runtime);
  } catch (error) {
    if (error?.name !== 'AbortError') applyPolish(runtime);
  }
}

async function loadBudgetAccountTransactions(current, signal) {
  const accountId = Number(current?.settings?.target_account?.id);
  if (!Number.isSafeInteger(accountId) || accountId < 1) return [];
  const response = await fetch(`${API_PREFIX}/accounts/${encodeURIComponent(accountId)}/transactions`, {
    credentials: 'same-origin',
    cache: 'no-store',
    signal
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  return Array.isArray(payload?.data?.transactions) ? payload.data.transactions : [];
}

function schedulePolish(runtime) {
  if (runtime.scheduled || runtime.signal?.aborted) return;
  runtime.scheduled = true;
  requestAnimationFrame(() => {
    runtime.scheduled = false;
    if (!runtime.signal?.aborted) applyPolish(runtime);
  });
}

function applyPolish(runtime) {
  moveAccountsToBottom(runtime);
  simplifyWeeklyBudget(runtime);
  renderWeeklyBudgetChart(runtime);
  insertBudgetWeekSeparators(runtime);
}

function moveAccountsToBottom(runtime) {
  const accounts = runtime.main.querySelector('[data-banking-accounts-panel]');
  if (!accounts || runtime.main.lastElementChild === accounts) return;
  runtime.main.append(accounts);
}

function collapseAccountsByDefault(runtime) {
  const accounts = runtime.main.querySelector('[data-banking-accounts-panel]');
  if (!accounts) return;
  let stored = null;
  try { stored = sessionStorage.getItem('yuvomi:banking:accounts-open'); } catch { /* optional */ }
  if (stored !== '1') accounts.open = false;
}

function simplifyWeeklyBudget(runtime) {
  const panel = runtime.main.querySelector('[data-banking-weekly-budget]');
  if (!panel) return;
  panel.classList.add('banking-weekly-budget--compact');
  panel.querySelector('.banking-panel__header .banking-panel__description')?.remove();

  const cards = [...panel.querySelectorAll('.banking-weekly-summary__card')];
  const labels = ['Budget-Konto', 'Direktausgaben', 'Auffüllbetrag'];
  cards.forEach((card, index) => {
    const label = card.querySelector(':scope > span');
    if (label && labels[index] && label.textContent !== labels[index]) label.textContent = labels[index];
    const small = card.querySelector(':scope > small');
    if (!small) return;
    if (index === 2) {
      const cutoff = formatShortDateTime(runtime.weeklyBudget?.period?.next_cutoff_at);
      if (cutoff) {
        const compact = `Stichtag ${cutoff}`;
        if (small.textContent !== compact) small.textContent = compact;
        return;
      }
    }
    small.remove();
  });
}

function renderWeeklyBudgetChart(runtime) {
  const panel = runtime.main.querySelector('[data-banking-weekly-budget]');
  const summary = panel?.querySelector('.banking-weekly-summary');
  const current = runtime.weeklyBudget;
  if (!panel || !summary || current?.configured !== true || current?.enabled === false) {
    panel?.querySelector('[data-weekly-budget-detail-chart]')?.remove();
    runtime.chartSignature = '';
    return;
  }

  const model = buildDetailedBudgetChartModel(current, runtime.budgetTransactions);
  if (!model) return;
  const signature = JSON.stringify({
    available: current?.available_to_spend_cents,
    start: current?.period?.start_date,
    end: current?.period?.end_date,
    entries: model.events.map((entry) => [entry.id, entry.date, entry.signedCents, entry.balanceCents])
  });
  const existing = panel.querySelector('[data-weekly-budget-detail-chart]');
  if (existing && runtime.chartSignature === signature) return;
  runtime.chartSignature = signature;

  const chart = existing ?? document.createElement('section');
  chart.className = 'banking-weekly-budget-chart';
  chart.dataset.weeklyBudgetDetailChart = 'true';
  chart.replaceChildren();

  const header = document.createElement('div');
  header.className = 'banking-weekly-budget-chart__header';
  const heading = document.createElement('div');
  const title = document.createElement('h3');
  title.textContent = 'Budgetverlauf';
  const subtitle = document.createElement('p');
  subtitle.textContent = 'Jeder Punkt ist ein gebuchter Umsatz auf dem Budget-Konto.';
  heading.append(title, subtitle);

  const legend = document.createElement('div');
  legend.className = 'banking-weekly-budget-chart__legend';
  legend.append(
    legendItem('incoming', 'Eingang'),
    legendItem('outgoing', 'Ausgabe')
  );
  header.append(heading, legend);

  const viewport = document.createElement('div');
  viewport.className = 'banking-weekly-budget-chart__viewport';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('banking-weekly-budget-chart__svg');
  svg.setAttribute('viewBox', '0 0 960 280');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Verlauf des verfügbaren Wochenbudgets mit einzelnen Ein- und Ausgängen');
  const tooltip = document.createElement('div');
  tooltip.className = 'banking-weekly-budget-chart__tooltip';
  tooltip.hidden = true;
  tooltip.setAttribute('role', 'status');
  viewport.append(svg, tooltip);

  renderDetailedBudgetSvg(svg, tooltip, viewport, model);
  chart.append(header, viewport);
  if (!existing) summary.after(chart);
}

function legendItem(direction, label) {
  const item = document.createElement('span');
  const dot = document.createElement('i');
  dot.dataset.direction = direction;
  dot.setAttribute('aria-hidden', 'true');
  item.append(dot, document.createTextNode(label));
  return item;
}

export function buildDetailedBudgetChartModel(current, transactions) {
  const availableCents = safeCents(current?.available_to_spend_cents);
  const targetCents = safeCents(current?.settings?.target_amount_cents);
  const startDate = String(current?.period?.start_date ?? '');
  const endDate = String(current?.period?.end_date ?? '');
  if (availableCents === null || !isIsoDate(startDate) || !isIsoDate(endDate)) return null;

  const filtered = (Array.isArray(transactions) ? transactions : [])
    .map((transaction) => {
      const date = effectiveTransactionDate(transaction);
      const amountCents = majorAmountToCents(transaction?.amount);
      if (!date || date < startDate || date >= endDate || amountCents === null || transaction?.status !== 'BOOK') return null;
      const direction = transaction?.direction === 'incoming' ? 'incoming' : 'outgoing';
      return {
        raw: transaction,
        id: String(transaction?.id ?? ''),
        date,
        amountCents,
        signedCents: direction === 'incoming' ? amountCents : -amountCents,
        direction,
        title: transactionTitle(transaction)
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.date.localeCompare(right.date) || numericId(left.id) - numericId(right.id));

  const totalNet = filtered.reduce((sum, entry) => sum + entry.signedCents, 0);
  let runningBalance = availableCents - totalNet;
  const byDate = new Map();
  for (const entry of filtered) {
    const group = byDate.get(entry.date) ?? [];
    group.push(entry);
    byDate.set(entry.date, group);
  }

  const events = [];
  for (const entry of filtered) {
    runningBalance += entry.signedCents;
    const sameDay = byDate.get(entry.date) ?? [entry];
    const index = sameDay.indexOf(entry);
    const dayOffset = dayDistance(startDate, entry.date);
    events.push({
      ...entry,
      balanceCents: runningBalance,
      dayPosition: dayOffset + (index + 1) / (sameDay.length + 1)
    });
  }

  const finalBalance = events.length ? events[events.length - 1].balanceCents : runningBalance;
  if (events.length && finalBalance !== availableCents) {
    events[events.length - 1].balanceCents += availableCents - finalBalance;
  }
  return {
    startDate,
    endDate,
    targetCents: targetCents ?? availableCents,
    availableCents,
    startBalanceCents: availableCents - totalNet,
    events
  };
}

function renderDetailedBudgetSvg(svg, tooltip, viewport, model) {
  svg.replaceChildren();
  const width = 960;
  const height = 280;
  const left = 64;
  const right = 18;
  const top = 18;
  const bottom = 42;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const periodDays = Math.max(1, dayDistance(model.startDate, model.endDate));
  const values = [model.startBalanceCents, model.availableCents, model.targetCents, ...model.events.map((event) => event.balanceCents)];
  let min = Math.min(...values, 0);
  let max = Math.max(...values, 1);
  const padding = Math.max(100, Math.round((max - min) * 0.12));
  min -= padding;
  max += padding;
  const span = Math.max(1, max - min);
  const xFor = (dayPosition) => left + clamp(dayPosition / periodDays, 0, 1) * plotWidth;
  const yFor = (value) => top + ((max - value) / span) * plotHeight;

  for (let step = 0; step <= 4; step += 1) {
    const value = max - (span * step / 4);
    const y = top + (plotHeight * step / 4);
    const line = svgNode('line', 'banking-weekly-budget-chart__grid-line');
    line.setAttribute('x1', String(left));
    line.setAttribute('x2', String(width - right));
    line.setAttribute('y1', String(y));
    line.setAttribute('y2', String(y));
    const label = svgNode('text', 'banking-weekly-budget-chart__axis-label');
    label.setAttribute('x', String(left - 8));
    label.setAttribute('y', String(y + 4));
    label.setAttribute('text-anchor', 'end');
    label.textContent = compactEuro(value);
    svg.append(line, label);
  }

  for (let day = 0; day < periodDays; day += 1) {
    const x = xFor(day + 0.5);
    const guide = svgNode('line', 'banking-weekly-budget-chart__day-guide');
    guide.setAttribute('x1', String(x));
    guide.setAttribute('x2', String(x));
    guide.setAttribute('y1', String(top));
    guide.setAttribute('y2', String(top + plotHeight));
    const label = svgNode('text', 'banking-weekly-budget-chart__day-label');
    label.setAttribute('x', String(x));
    label.setAttribute('y', String(height - 14));
    label.setAttribute('text-anchor', 'middle');
    label.textContent = formatDayLabel(addIsoDays(model.startDate, day));
    svg.append(guide, label);
  }

  const targetY = yFor(model.targetCents);
  const targetLine = svgNode('line', 'banking-weekly-budget-chart__target-line');
  targetLine.setAttribute('x1', String(left));
  targetLine.setAttribute('x2', String(width - right));
  targetLine.setAttribute('y1', String(targetY));
  targetLine.setAttribute('y2', String(targetY));
  svg.append(targetLine);

  const pathPoints = [{ x: xFor(0), y: yFor(model.startBalanceCents) }];
  for (const event of model.events) pathPoints.push({ x: xFor(event.dayPosition), y: yFor(event.balanceCents) });
  const lastEventPosition = model.events.at(-1)?.dayPosition ?? 0;
  const currentPosition = Math.max(lastEventPosition, Math.min(periodDays, currentDayPosition(model.startDate, model.endDate)));
  pathPoints.push({ x: xFor(currentPosition), y: yFor(model.availableCents) });

  const area = svgNode('path', 'banking-weekly-budget-chart__area');
  area.setAttribute('d', `M ${pathPoints[0].x} ${top + plotHeight} ${pathPoints.map((point) => `L ${point.x} ${point.y}`).join(' ')} L ${pathPoints.at(-1).x} ${top + plotHeight} Z`);
  const line = svgNode('polyline', 'banking-weekly-budget-chart__line');
  line.setAttribute('points', pathPoints.map((point) => `${point.x},${point.y}`).join(' '));
  svg.append(area, line);

  for (const event of model.events) {
    const x = xFor(event.dayPosition);
    const y = yFor(event.balanceCents);
    const marker = svgNode('circle', 'banking-weekly-budget-chart__event');
    marker.dataset.direction = event.direction;
    marker.setAttribute('cx', String(x));
    marker.setAttribute('cy', String(y));
    marker.setAttribute('r', '6');
    marker.setAttribute('tabindex', '0');
    marker.setAttribute('role', 'button');
    marker.setAttribute('aria-label', `${formatFullDate(event.date)}, ${event.title}, ${formatSignedCents(event.signedCents)}, Stand ${formatCents(event.balanceCents)}`);
    marker.addEventListener('pointerenter', (pointerEvent) => showBudgetTooltip(tooltip, viewport, event, pointerEvent));
    marker.addEventListener('pointermove', (pointerEvent) => positionBudgetTooltip(tooltip, viewport, pointerEvent.clientX, pointerEvent.clientY));
    marker.addEventListener('pointerleave', () => hideBudgetTooltip(tooltip));
    marker.addEventListener('focus', () => showBudgetTooltipAtMarker(tooltip, viewport, marker, event));
    marker.addEventListener('blur', () => hideBudgetTooltip(tooltip));
    svg.append(marker);
  }

  const currentDot = svgNode('circle', 'banking-weekly-budget-chart__current-dot');
  currentDot.setAttribute('cx', String(xFor(currentPosition)));
  currentDot.setAttribute('cy', String(yFor(model.availableCents)));
  currentDot.setAttribute('r', '4.5');
  svg.append(currentDot);
}

function svgNode(name, className) {
  const node = document.createElementNS(SVG_NS, name);
  node.setAttribute('class', className);
  return node;
}

function showBudgetTooltip(tooltip, viewport, event, pointerEvent) {
  populateBudgetTooltip(tooltip, event);
  tooltip.hidden = false;
  positionBudgetTooltip(tooltip, viewport, pointerEvent.clientX, pointerEvent.clientY);
}

function showBudgetTooltipAtMarker(tooltip, viewport, marker, event) {
  populateBudgetTooltip(tooltip, event);
  tooltip.hidden = false;
  const rect = marker.getBoundingClientRect();
  positionBudgetTooltip(tooltip, viewport, rect.left + rect.width / 2, rect.top);
}

function populateBudgetTooltip(tooltip, event) {
  tooltip.replaceChildren();
  const date = document.createElement('span');
  date.className = 'banking-weekly-budget-chart__tooltip-date';
  date.textContent = formatFullDate(event.date);
  const title = document.createElement('strong');
  title.textContent = event.title;
  const amount = document.createElement('b');
  amount.dataset.direction = event.direction;
  amount.textContent = formatSignedCents(event.signedCents);
  const balance = document.createElement('small');
  balance.textContent = `Stand danach: ${formatCents(event.balanceCents)}`;
  tooltip.append(date, title, amount, balance);
}

function positionBudgetTooltip(tooltip, viewport, clientX, clientY) {
  const viewportRect = viewport.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  let left = clientX - viewportRect.left + 12;
  let top = clientY - viewportRect.top - tooltipRect.height - 12;
  if (left + tooltipRect.width > viewportRect.width - 8) left = viewportRect.width - tooltipRect.width - 8;
  if (left < 8) left = 8;
  if (top < 8) top = clientY - viewportRect.top + 12;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${Math.min(top, Math.max(8, viewportRect.height - tooltipRect.height - 8))}px`;
}

function hideBudgetTooltip(tooltip) {
  tooltip.hidden = true;
}

function transactionTitle(transaction) {
  return String(
    transaction?.merchant_name
    || transaction?.counterparty_name
    || transaction?.purpose
    || 'Umsatz'
  );
}

function effectiveTransactionDate(transaction) {
  for (const value of [transaction?.booking_date, transaction?.value_date, transaction?.transaction_date]) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  }
  return '';
}

function numericId(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function safeCents(value) {
  const cents = Number(value);
  return Number.isSafeInteger(cents) ? cents : null;
}

function majorAmountToCents(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  const cents = Math.round(Math.abs(amount) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

function formatCents(value) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR' }).format(Number(value) / 100);
}

function formatSignedCents(value) {
  const cents = Number(value);
  const formatted = formatCents(Math.abs(cents));
  return cents >= 0 ? `+${formatted}` : `−${formatted}`;
}

function compactEuro(value) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Number(value) / 100);
}

function formatDayLabel(date) {
  const parsed = parseIsoDate(date);
  return parsed ? new Intl.DateTimeFormat(undefined, { weekday: 'short', day: '2-digit', timeZone: 'UTC' }).format(parsed) : date;
}

function formatFullDate(date) {
  const parsed = parseIsoDate(date);
  return parsed ? new Intl.DateTimeFormat(undefined, { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(parsed) : date;
}

function isIsoDate(value) {
  return Boolean(parseIsoDate(value));
}

function dayDistance(startDate, endDate) {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  if (!start || !end) return 0;
  return Math.round((end.getTime() - start.getTime()) / DAY_MS);
}

function currentDayPosition(startDate, endDate) {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  if (!start || !end) return 0;
  const today = new Date();
  const utcToday = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return clamp((utcToday - start.getTime()) / DAY_MS + 0.5, 0, (end.getTime() - start.getTime()) / DAY_MS);
}

function addIsoDays(date, days) {
  const parsed = parseIsoDate(date);
  return parsed ? isoDate(addDays(parsed, days)) : '';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function insertBudgetWeekSeparators(runtime) {
  const table = runtime.main.querySelector('.banking-transactions-table');
  const body = table?.tBodies?.[0];
  const anchor = parseIsoDate(runtime.weeklyBudget?.period?.start_date);
  if (!table || !body || !anchor) return;

  const rows = [...body.querySelectorAll('tr[data-transaction-row][data-transaction-id]')];
  const rowDates = rows.map((row) => ({ row, date: parseRowDate(row) })).filter((item) => item.date);
  const signature = `${isoDate(anchor)}|${rowDates.map(({ row, date }) => `${row.dataset.transactionId}:${isoDate(date)}`).join('|')}`;
  if (signature === runtime.tableSignature) return;
  runtime.tableSignature = signature;

  body.querySelectorAll('[data-budget-week-separator]').forEach((separator) => separator.remove());
  let previousKey = null;
  for (const { row, date } of rowDates) {
    const weekStart = budgetWeekStart(date, anchor);
    const key = isoDate(weekStart);
    if (previousKey !== null && key !== previousKey) {
      row.before(createBudgetWeekSeparator(row, weekStart));
    }
    previousKey = key;
  }
}

function createBudgetWeekSeparator(referenceRow, weekStart) {
  const weekEnd = addDays(weekStart, 6);
  const row = document.createElement('tr');
  row.className = 'banking-budget-week-separator';
  row.dataset.budgetWeekSeparator = isoDate(weekStart);
  const cell = document.createElement('td');
  cell.colSpan = Math.max(1, referenceRow.cells.length);
  const content = document.createElement('div');
  content.className = 'banking-budget-week-separator__content';
  const label = document.createElement('span');
  label.textContent = `Budgetwoche ${formatShortDate(weekStart)}–${formatShortDate(weekEnd)}`;
  content.append(label);
  cell.append(content);
  row.append(cell);
  return row;
}

function budgetWeekStart(date, anchor) {
  const difference = Math.floor((date.getTime() - anchor.getTime()) / DAY_MS);
  const offset = Math.floor(difference / 7) * 7;
  return addDays(anchor, offset);
}

function parseRowDate(row) {
  const text = row.querySelector('.banking-transactions-table__date')?.textContent?.trim();
  if (!text || text === '–') return null;
  const values = text.match(/\d+/g)?.map(Number) ?? [];
  if (values.length < 3) return null;

  const order = new Intl.DateTimeFormat(undefined, { dateStyle: 'short' })
    .formatToParts(new Date(2001, 10, 22))
    .filter((part) => ['day', 'month', 'year'].includes(part.type))
    .map((part) => part.type);
  if (order.length !== 3) return null;

  const parts = Object.fromEntries(order.map((type, index) => [type, values[index]]));
  let year = Number(parts.year);
  if (year < 100) year += 2000;
  return utcCalendarDate(year, Number(parts.month), Number(parts.day));
}

function parseIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  return match ? utcCalendarDate(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

function utcCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function isoDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function formatShortDate(date) {
  return new Intl.DateTimeFormat(undefined, { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'UTC' }).format(date);
}

function formatShortDateTime(value) {
  if (typeof value !== 'string' || !value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(date);
}

function hasRelevantMutation(record) {
  const nodes = [...record.addedNodes, ...record.removedNodes];
  if (nodes.length === 0) return false;
  return nodes.some((node) => {
    if (!(node instanceof Element)) return true;
    if (node.matches('[data-budget-week-separator], [data-weekly-budget-detail-chart]') || node.closest('[data-budget-week-separator], [data-weekly-budget-detail-chart]')) return false;
    return true;
  });
}

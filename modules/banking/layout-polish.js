const API_PREFIX = '/api/extensions/banking';
const STYLE_ID = 'banking-main-layout-polish';
const DAY_MS = 86_400_000;

export async function installMainLayoutPolish(container, context = {}) {
  const main = container.querySelector('[data-banking-main-content]');
  if (!main) return;

  ensureStyles();
  const runtime = {
    container,
    main,
    signal: context?.signal,
    weeklyBudget: null,
    scheduled: false,
    tableSignature: ''
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
    applyPolish(runtime);
  } catch (error) {
    if (error?.name !== 'AbortError') applyPolish(runtime);
  }
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
    if (node.matches('[data-budget-week-separator]') || node.closest('[data-budget-week-separator]')) return false;
    return true;
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const WIDGET_STYLE_MARKER = 'banking-weekly-budget-widget-style';

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

  const title = document.createElement('strong');
  title.className = 'banking-weekly-widget__title';
  title.textContent = message('Wochenbudget', 'Weekly budget');

  const text = document.createElement('p');
  text.className = 'banking-weekly-widget__remaining';
  text.textContent = message('Wird geladen …', 'Loading ...');

  const amount = document.createElement('strong');
  amount.className = 'banking-weekly-widget__amount';
  amount.hidden = true;

  const progress = document.createElement('div');
  progress.className = 'banking-weekly-widget__progress';
  progress.hidden = true;
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-label', message(
    'Verbleibende Zeit dieser Budgetwoche',
    'Remaining time in this budget week'
  ));
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', '100');

  const progressFill = document.createElement('span');
  progressFill.className = 'banking-weekly-widget__progress-fill';
  progressFill.style.width = '0%';
  progress.append(progressFill);

  const content = document.createElement('div');
  content.className = 'banking-weekly-widget__content';
  content.append(amount, progress, text);
  wrapper.append(title, content);
  container.append(wrapper);

  try {
    const response = await fetch('/api/extensions/banking/weekly-budget/current', {
      credentials: 'same-origin',
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const current = (await response.json())?.data;

    if (current?.configured !== true) {
      text.textContent = message('Noch nicht eingerichtet.', 'Not configured yet.');
      return;
    }
    if (current?.enabled === false) {
      text.textContent = message('Aktuell deaktiviert.', 'Currently disabled.');
      return;
    }

    amount.hidden = false;
    amount.textContent = formatCents(current?.available_to_spend_cents);
    const progressValue = calculateRemainingWeeklyBudgetProgress(
      current?.period?.next_cutoff_at,
      Date.now()
    );
    if (progressValue === null) {
      progress.hidden = true;
      progress.removeAttribute('aria-valuenow');
    } else {
      const percentage = Math.round(progressValue * 100);
      progress.hidden = false;
      progress.setAttribute('aria-valuenow', String(percentage));
      progressFill.style.width = `${percentage}%`;
    }
    text.textContent = formatRemainingWeeklyBudget(
      current?.period?.next_cutoff_at,
      Date.now(),
      document.documentElement.lang
    );
  } catch {
    text.textContent = message('Wochenbudget nicht verfügbar.', 'Weekly budget unavailable.');
  } finally {
    wrapper.removeAttribute('aria-busy');
  }
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

export function formatRemainingWeeklyBudget(nextCutoffAt, now = Date.now(), locale = 'de') {
  const days = calculateRemainingWeeklyBudgetDays(nextCutoffAt, now);
  const german = String(locale).toLowerCase().startsWith('de');
  if (days === null) return german ? 'Zeitraum nicht verfügbar' : 'Period unavailable.';
  if (days === 0) return german ? 'noch heute' : 'ends today';
  if (german) return days === 1 ? 'noch 1 Tag' : `noch ${days} Tage`;
  return days === 1 ? '1 day left' : `${days} days left`;
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

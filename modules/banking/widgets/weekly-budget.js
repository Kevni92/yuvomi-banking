const DAY_MS = 24 * 60 * 60 * 1000;

export async function renderWidget(container) {
  container.replaceChildren();

  const wrapper = document.createElement('a');
  wrapper.className = 'banking-weekly-widget';
  wrapper.href = '/m/banking';
  wrapper.dataset.route = '/m/banking';
  wrapper.setAttribute('aria-label', message('Banking öffnen', 'Open Banking'));
  wrapper.setAttribute('aria-busy', 'true');

  const title = document.createElement('strong');
  title.textContent = message('Wochenbudget', 'Weekly budget');

  const text = document.createElement('p');
  text.className = 'banking-weekly-widget__remaining';
  text.textContent = message('Wird geladen …', 'Loading ...');

  wrapper.append(title, text);
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

    const amount = document.createElement('strong');
    amount.className = 'banking-weekly-widget__amount';
    amount.textContent = formatCents(current?.available_to_spend_cents);
    text.textContent = formatRemainingWeeklyBudget(
      current?.period?.next_cutoff_at,
      Date.now(),
      document.documentElement.lang
    );
    text.replaceWith(amount);
    wrapper.append(text);
  } catch {
    text.textContent = message('Wochenbudget nicht verfügbar.', 'Weekly budget unavailable.');
  } finally {
    wrapper.removeAttribute('aria-busy');
  }
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

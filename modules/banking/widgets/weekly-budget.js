export async function renderWidget(container) {
  container.replaceChildren();

  const wrapper = document.createElement('div');
  wrapper.className = 'banking-weekly-widget';
  wrapper.setAttribute('aria-busy', 'true');

  const title = document.createElement('strong');
  title.textContent = message('Wochenbudget', 'Weekly budget');

  const text = document.createElement('p');
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
    const detail = document.createElement('small');
    const calculation = current?.provisional_calculation;
    detail.textContent = calculation
      ? message(
          `Aktuelle Auffüllung: ${formatCents(calculation.transfer_amount_cents)}`,
          `Current refill: ${formatCents(calculation.transfer_amount_cents)}`
        )
      : message('Noch keine verlässliche Berechnung.', 'No reliable calculation yet.');
    text.replaceWith(amount, detail);
  } catch {
    text.textContent = message('Wochenbudget nicht verfügbar.', 'Weekly budget unavailable.');
  } finally {
    wrapper.removeAttribute('aria-busy');
  }
}

function formatCents(value) {
  const cents = Number(value);
  if (!Number.isSafeInteger(cents)) return '–';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'EUR'
  }).format(cents / 100);
}

function message(german, english) {
  return document.documentElement.lang?.toLowerCase().startsWith('de') ? german : english;
}

const API_PREFIX = '/api/extensions/banking';

export async function installPresentationSettings(container, context = {}) {
  const settingsRoot = container.querySelector('[data-banking-settings-content]');
  if (!settingsRoot || settingsRoot.querySelector('[data-banking-presentation-settings]')) return;

  const section = document.createElement('section');
  section.className = 'banking-panel';
  section.dataset.bankingPresentationSettings = 'true';
  section.innerHTML = `
    <div class="banking-panel__header">
      <div>
        <h2>Darstellung</h2>
        <p class="banking-panel__description">Lege fest, welche Information als Titel eines Umsatzes verwendet wird.</p>
      </div>
    </div>
    <form data-banking-presentation-settings-form>
      <label class="banking-field">
        <span>Umsatztitel</span>
        <select class="form-input" data-transaction-title-mode>
          <option value="smart">Intelligent (empfohlen)</option>
          <option value="counterparty">Händler / Empfänger bevorzugen</option>
          <option value="transaction_type">Umsatzart bevorzugen</option>
        </select>
      </label>
      <p class="banking-muted" data-transaction-title-mode-help></p>
      <div class="banking-provider-settings__actions">
        <button class="btn btn--primary" type="submit" data-action="save-presentation-settings">Speichern</button>
      </div>
      <p class="banking-feedback" data-presentation-settings-feedback role="status"></p>
    </form>
  `;

  const weeklyBudgetSection = settingsRoot.querySelector('[data-banking-weekly-budget]');
  if (weeklyBudgetSection) settingsRoot.insertBefore(section, weeklyBudgetSection);
  else settingsRoot.append(section);

  const select = section.querySelector('[data-transaction-title-mode]');
  const help = section.querySelector('[data-transaction-title-mode-help]');
  const form = section.querySelector('[data-banking-presentation-settings-form]');
  const feedback = section.querySelector('[data-presentation-settings-feedback]');
  const saveButton = section.querySelector('[data-action="save-presentation-settings"]');
  const canWrite = container.dataset.bankingPermission === 'write';
  select.disabled = !canWrite;
  saveButton.disabled = !canWrite;

  const updateHelp = () => {
    help.textContent = {
      smart: 'Nutzt einen echten Händler, wenn er zuverlässig erkannt wurde. Technische Banken, Kartenabwickler oder Automatenkennungen werden sonst durch die aussagekräftige Umsatzart ersetzt.',
      counterparty: 'Verhält sich wie die klassische Ansicht und bevorzugt Händler beziehungsweise Empfänger, auch wenn die Bank nur einen technischen Namen liefert.',
      transaction_type: 'Bevorzugt die von der Bank gemeldete Umsatzart, zum Beispiel „Bargeldauszahlung“ oder „E-COM (Apple Pay)“, vor Händler und Empfänger.'
    }[select.value] || '';
  };

  select.addEventListener('change', updateHelp, { signal: context?.signal });
  updateHelp();

  try {
    const response = await fetch(`${API_PREFIX}/presentation-settings`, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: context?.signal
    });
    if (response.ok) {
      const payload = await response.json();
      const mode = payload?.data?.transaction_title_mode;
      if (['smart', 'counterparty', 'transaction_type'].includes(mode)) select.value = mode;
      updateHelp();
    }
  } catch {
    if (!context?.signal?.aborted) feedback.textContent = 'Darstellungseinstellungen konnten nicht geladen werden.';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!canWrite) return;
    feedback.textContent = '';
    saveButton.disabled = true;
    try {
      const csrfResponse = await fetch(`${API_PREFIX}/csrf`, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: context?.signal
      });
      if (!csrfResponse.ok) throw new Error('CSRF token unavailable.');
      const csrf = await csrfResponse.json();
      const response = await fetch(`${API_PREFIX}/presentation-settings`, {
        method: 'PATCH',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: context?.signal,
        headers: {
          'content-type': 'application/json',
          'x-banking-csrf': csrf?.csrf_token ?? ''
        },
        body: JSON.stringify({ transaction_title_mode: select.value })
      });
      if (!response.ok) throw new Error('Presentation settings could not be saved.');
      feedback.textContent = 'Darstellung gespeichert. Die neue Titelregel gilt beim nächsten Laden der Umsätze.';
    } catch {
      if (!context?.signal?.aborted) feedback.textContent = 'Darstellungseinstellungen konnten nicht gespeichert werden.';
    } finally {
      if (!context?.signal?.aborted) saveButton.disabled = false;
    }
  }, { signal: context?.signal });
}

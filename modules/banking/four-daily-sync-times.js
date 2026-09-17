const API_PREFIX = '/api/extensions/banking';
const DEFAULT_CANDIDATES = ['12:00', '23:30', '00:00', '03:00', '09:00', '15:00', '21:00'];

export async function installFourDailySyncTimes(container, context = {}) {
  const form = container.querySelector('[data-weekly-budget-settings]');
  if (!form) return;
  ensureExtraFields(form, container.dataset.bankingPermission === 'write');
  await loadExtraSyncTimes(form, context?.signal);
  installSettingsFetchBridge(form, context?.signal);
}

function ensureExtraFields(form, canWrite) {
  if (form.querySelector('[data-weekly-sync-three]')) return;
  const second = form.querySelector('[data-weekly-sync-two]');
  const secondLabel = second?.closest('label');
  if (!secondLabel) return;
  const german = String(document.documentElement.lang || 'de').toLowerCase().startsWith('de');

  const third = createTimeField(
    german ? 'Dritter täglicher Abruf' : 'Third daily sync',
    'weeklySyncThree',
    'data-weekly-sync-three'
  );
  const fourth = createTimeField(
    german ? 'Vierter täglicher Abruf' : 'Fourth daily sync',
    'weeklySyncFour',
    'data-weekly-sync-four'
  );
  secondLabel.after(third, fourth);

  for (const input of [third.querySelector('input'), fourth.querySelector('input')]) {
    input.disabled = !canWrite;
  }

  const firstValue = form.querySelector('[data-weekly-sync-one]')?.value || '06:00';
  const secondValue = second.value || '18:00';
  const defaults = chooseExtraDefaults([firstValue, secondValue]);
  third.querySelector('input').value = defaults[0];
  fourth.querySelector('input').value = defaults[1];
}

function createTimeField(labelText, name, attribute) {
  const label = document.createElement('label');
  label.className = 'banking-field';
  const span = document.createElement('span');
  span.textContent = labelText;
  const input = document.createElement('input');
  input.className = 'form-input';
  input.type = 'time';
  input.required = true;
  input.name = name;
  input.setAttribute(attribute, '');
  label.append(span, input);
  return label;
}

async function loadExtraSyncTimes(form, signal) {
  try {
    const response = await fetch(`${API_PREFIX}/weekly-budget/sync-times`, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal
    });
    if (!response.ok) return;
    const data = (await response.json())?.data;
    if (!data) return;
    setTime(form, '[data-weekly-sync-one]', data.sync_time_1);
    setTime(form, '[data-weekly-sync-two]', data.sync_time_2);
    setTime(form, '[data-weekly-sync-three]', data.sync_time_3);
    setTime(form, '[data-weekly-sync-four]', data.sync_time_4);
  } catch {
    // The regular weekly-budget settings remain usable when the add-on request fails.
  }
}

function installSettingsFetchBridge(form, signal) {
  const previousFetch = window.fetch.bind(window);
  const patchedFetch = async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl, window.location.origin);
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const response = await previousFetch(input, init);

    if (
      response.ok
      && method === 'PUT'
      && url.pathname === `${API_PREFIX}/weekly-budget/settings`
    ) {
      const payload = syncTimesPayload(form);
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set('content-type', 'application/json');
      const extraResponse = await previousFetch(`${API_PREFIX}/weekly-budget/sync-times`, {
        method: 'PUT',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: init?.signal ?? signal,
        headers,
        body: JSON.stringify(payload)
      });
      if (!extraResponse.ok) {
        let detail = '';
        try {
          detail = String((await extraResponse.json())?.error || '');
        } catch {
          // Use the generic message below.
        }
        return new Response(JSON.stringify({
          error: detail || 'Die vier täglichen Abrufzeiten konnten nicht gespeichert werden.'
        }), {
          status: extraResponse.status >= 400 ? extraResponse.status : 500,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
        });
      }
    }
    return response;
  };

  window.fetch = patchedFetch;
  signal?.addEventListener('abort', () => {
    if (window.fetch === patchedFetch) window.fetch = previousFetch;
  }, { once: true });
}

function syncTimesPayload(form) {
  return {
    sync_time_1: requiredTime(form, '[data-weekly-sync-one]', '06:00'),
    sync_time_2: requiredTime(form, '[data-weekly-sync-two]', '18:00'),
    sync_time_3: requiredTime(form, '[data-weekly-sync-three]', '12:00'),
    sync_time_4: requiredTime(form, '[data-weekly-sync-four]', '23:30')
  };
}

function requiredTime(form, selector, fallback) {
  const value = form.querySelector(selector)?.value;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || '')) ? value : fallback;
}

function setTime(form, selector, value) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''))) return;
  const input = form.querySelector(selector);
  if (input) input.value = String(value);
}

function chooseExtraDefaults(existing) {
  const used = new Set(existing.filter(Boolean));
  const chosen = [];
  for (const candidate of DEFAULT_CANDIDATES) {
    if (used.has(candidate)) continue;
    chosen.push(candidate);
    used.add(candidate);
    if (chosen.length === 2) break;
  }
  return [chosen[0] || '12:00', chosen[1] || '23:30'];
}

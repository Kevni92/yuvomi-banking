import {
  renderPageHeader,
  renderPageTitle,
  renderPageBody,
  renderPageSection
} from '/utils/page-layout.js';
import { esc } from '/utils/html.js';
import { t } from '/i18n.js';

const API_PREFIX = '/api/extensions/banking';

function localized(key, fallback) {
  const value = t(`extensions.banking.${key}`);
  return value === `extensions.banking.${key}` ? fallback : value;
}

async function loadJson(path, signal) {
  const response = await fetch(`${API_PREFIX}/${path}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    signal
  });

  if (!response.ok) {
    throw new Error(`${localized('errors.request', 'Banking request failed')} (HTTP ${response.status})`);
  }

  return response.json();
}

export async function render(container, context) {
  const { signal } = context;

  container.replaceChildren();
  container.insertAdjacentHTML(
    'beforeend',
    renderPageHeader({ title: renderPageTitle(localized('title', 'Banking')) }) +
      renderPageBody({
        content: renderPageSection({
          content: `
            <div class="banking-integration-grid" aria-live="polite">
              <article class="banking-integration-card">
                <span class="banking-integration-card__label">${esc(localized('sidecar', 'Banking sidecar'))}</span>
                <strong class="banking-integration-card__value" data-banking-status>${esc(localized('sidecarChecking', 'Checking connection ...'))}</strong>
              </article>

              <article class="banking-integration-card">
                <span class="banking-integration-card__label">${esc(localized('user', 'Signed-in Yuvomi user'))}</span>
                <strong class="banking-integration-card__value" data-banking-user>${esc(localized('checking', 'Checking ...'))}</strong>
              </article>

              <article class="banking-integration-card">
                <span class="banking-integration-card__label">${esc(localized('permission', 'Banking permission'))}</span>
                <strong class="banking-integration-card__value" data-banking-permission>${esc(localized('checking', 'Checking ...'))}</strong>
              </article>
            </div>

            <div class="banking-empty-state">
              <h2>Yuvomi Banking</h2>
              <p>
                ${esc(localized('description', 'The Banking module is connected to its separate sidecar. Bank data features will be added in later phases.'))}
              </p>
            </div>
          `
        })
      })
  );

  const statusNode = container.querySelector('[data-banking-status]');
  const userNode = container.querySelector('[data-banking-user]');
  const permissionNode = container.querySelector('[data-banking-permission]');

  const [healthResult, sessionResult] = await Promise.allSettled([
    loadJson('health', signal),
    loadJson('me', signal)
  ]);
  if (signal.aborted) return;

  if (healthResult.status === 'fulfilled' && healthResult.value?.ok === true) {
    statusNode.textContent = localized('sidecarConnected', 'Connected');
    statusNode.dataset.state = 'connected';
  } else {
    const error = healthResult.status === 'rejected' ? healthResult.reason : null;
    statusNode.textContent = error instanceof Error
      ? error.message
      : localized('sidecarDisconnected', 'Not connected');
    statusNode.dataset.state = 'disconnected';
  }

  if (sessionResult.status === 'fulfilled') {
    const session = sessionResult.value?.data;
    userNode.textContent = session?.display_name || localized('unknownUser', 'Unknown user');
    permissionNode.textContent = session?.banking_permission || localized('noPermission', 'No permission');
    permissionNode.dataset.state = session?.banking_permission || 'none';
  } else {
    const error = sessionResult.reason;
    userNode.textContent = error instanceof Error
      ? error.message
      : localized('sessionUnavailable', 'Yuvomi session unavailable.');
    permissionNode.textContent = localized('noPermission', 'No permission');
    permissionNode.dataset.state = 'none';
  }
}

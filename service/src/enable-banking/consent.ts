export const DEFAULT_CONSENT_DURATION_SECONDS = 90 * 24 * 60 * 60;
export const CONSERVATIVE_CONSENT_DURATION_SECONDS = 30 * 24 * 60 * 60;

export interface ConsentValidityOptions {
  now?: Date;
  desiredDurationSeconds?: number;
  maximumConsentValidity?: unknown;
  fallbackDurationSeconds?: number;
}

/**
 * Enable Banking reports maximum_consent_validity in seconds. Keep the value
 * provider-controlled, but reject malformed values before using them in the
 * consent request.
 */
export function parseMaximumConsentValidity(value: unknown): number | null {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) return null;
  return Number(value);
}

export function calculateConsentValidUntil({
  now = new Date(),
  desiredDurationSeconds = DEFAULT_CONSENT_DURATION_SECONDS,
  maximumConsentValidity,
  fallbackDurationSeconds = CONSERVATIVE_CONSENT_DURATION_SECONDS
}: ConsentValidityOptions = {}): string {
  if (!Number.isFinite(now.getTime())) throw new Error('Consent calculation time is invalid.');

  const desired = positiveSafeInteger(desiredDurationSeconds, 'desired consent duration');
  const fallback = positiveSafeInteger(fallbackDurationSeconds, 'fallback consent duration');
  const maximum = parseMaximumConsentValidity(maximumConsentValidity);
  const duration = maximum === null ? fallback : Math.min(desired, maximum);
  const validUntil = new Date(now.getTime() + duration * 1_000);
  if (!Number.isFinite(validUntil.getTime())) throw new Error('Consent validity is out of range.');
  return validUntil.toISOString();
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return Number(value);
}

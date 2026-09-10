import crypto from 'node:crypto';

const DEFAULT_TTL_SECONDS = 3_600;
const MAX_TTL_SECONDS = 86_400;

export interface EnableBankingJwtOptions {
  applicationId: string;
  privateKey: crypto.KeyObject | string | Buffer;
  nowSeconds?: number;
  ttlSeconds?: number;
}

function encodeJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function createEnableBankingJwt({
  applicationId,
  privateKey,
  nowSeconds = Math.floor(Date.now() / 1_000),
  ttlSeconds = DEFAULT_TTL_SECONDS
}: EnableBankingJwtOptions): string {
  if (!applicationId.trim()) {
    throw new Error('ENABLE_BANKING_APPLICATION_ID is required.');
  }
  if (!Number.isInteger(nowSeconds) || nowSeconds < 0) {
    throw new Error('JWT clock value is invalid.');
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error('Enable Banking JWT TTL must be between 1 and 86400 seconds.');
  }

  const header = encodeJson({ typ: 'JWT', alg: 'RS256', kid: applicationId });
  const payload = encodeJson({
    iss: 'enablebanking.com',
    aud: 'api.enablebanking.com',
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds
  });
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(signingInput, 'ascii'),
    privateKey
  ).toString('base64url');

  return `${signingInput}.${signature}`;
}

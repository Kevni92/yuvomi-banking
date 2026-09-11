import fs from 'node:fs';
import path from 'node:path';

function optional(name: string, fallback = ''): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  const filePath = process.env[`${name}_FILE`]?.trim();
  if (!filePath) return fallback;
  try {
    return fs.readFileSync(filePath, 'utf8').trim() || fallback;
  } catch {
    throw new Error(`${name}_FILE could not be read.`);
  }
}

function portFromEnvironment(): number {
  const value = Number(optional('PORT', '3100'));
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return value;
}

export const config = {
  host: optional('HOST', '127.0.0.1'),
  port: portFromEnvironment(),
  yuvomiInternalUrl: optional('YUVOMI_INTERNAL_URL', 'http://127.0.0.1:3000'),
  publicOrigin: optional('PUBLIC_ORIGIN', 'http://localhost:8080'),
  dbPath: path.resolve(optional('BANKING_DB_PATH', '../data/banking.db')),
  merchantLogoCacheDir: path.resolve(optional('MERCHANT_LOGO_CACHE_DIR', '../data/merchant-logos')),
  vapid: {
    subject: optional('BANKING_VAPID_SUBJECT'),
    publicKey: optional('BANKING_VAPID_PUBLIC_KEY'),
    privateKey: optional('BANKING_VAPID_PRIVATE_KEY')
  },

  enableBanking: {
    environment: optional('ENABLE_BANKING_ENV', 'sandbox'),
    apiUrl: optional('ENABLE_BANKING_API_URL', 'https://api.enablebanking.com'),
    applicationId: optional('ENABLE_BANKING_APPLICATION_ID'),
    apiKey: optional('ENABLE_BANKING_API_KEY'),
    privateKeyPath: path.resolve(
      optional('ENABLE_BANKING_PRIVATE_KEY_PATH', '../secrets/enablebanking-private.pem')
    )
  },

  secrets: {
    counterpartyHmac: optional('COUNTERPARTY_HMAC_SECRET'),
    dataEncryptionKey: optional('BANKING_DATA_ENCRYPTION_KEY'),
    openAiApiKey: optional('OPENAI_API_KEY')
  },

  openAiModel: optional('OPENAI_MODEL')
};

export function assertProductionSecrets(): void {
  if (!config.secrets.counterpartyHmac) {
    throw new Error('COUNTERPARTY_HMAC_SECRET is required before bank data is imported.');
  }
  if (!config.secrets.dataEncryptionKey) {
    throw new Error('BANKING_DATA_ENCRYPTION_KEY is required before sensitive bank data is stored.');
  }
}

import path from 'node:path';

function optional(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

function portFromEnvironment(): number {
  const value = Number(optional('PORT', '3100'));
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return value;
}

export const config = {
  port: portFromEnvironment(),
  yuvomiInternalUrl: optional('YUVOMI_INTERNAL_URL', 'http://127.0.0.1:3000'),
  publicOrigin: optional('PUBLIC_ORIGIN', 'http://localhost:8080'),
  dbPath: path.resolve(optional('BANKING_DB_PATH', '../data/banking.db')),

  enableBanking: {
    environment: optional('ENABLE_BANKING_ENV', 'sandbox'),
    apiUrl: optional('ENABLE_BANKING_API_URL', 'https://api.enablebanking.com'),
    applicationId: optional('ENABLE_BANKING_APPLICATION_ID'),
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

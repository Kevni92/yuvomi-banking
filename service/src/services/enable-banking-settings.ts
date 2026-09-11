import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { createEncryptionService } from '../security/encryption.js';

const APPLICATION_ID_SETTING = 'enable_banking.application_id_encrypted';
const API_KEY_SETTING = 'enable_banking.api_key_encrypted';
const PRIVATE_KEY_SETTING = 'enable_banking.private_key_encrypted';
const ENVIRONMENT_SETTING = 'enable_banking.environment';
const API_URL_SETTING = 'enable_banking.api_url';
const MAX_APPLICATION_ID_LENGTH = 200;
const MAX_API_KEY_LENGTH = 500;
const MAX_PRIVATE_KEY_LENGTH = 100_000;

export class EnableBankingSettingsValidationError extends Error {}

interface SettingRow {
  value: string;
}

export interface EnableBankingRuntimeSettings {
  environment: string;
  apiUrl: string;
  applicationId: string;
  apiKey: string;
  privateKey: string;
  privateKeyPath: string;
}

export interface EnableBankingSettingsResponse {
  environment: string;
  api_url: string;
  application_id_configured: boolean;
  api_key_configured: boolean;
  private_key_configured: boolean;
}

export function readEnableBankingRuntimeSettings(
  database?: DatabaseSync
): EnableBankingRuntimeSettings {
  let environment = config.enableBanking.environment;
  let apiUrl = config.enableBanking.apiUrl;
  let applicationId = config.enableBanking.applicationId;
  let apiKey = config.enableBanking.apiKey;
  let privateKey = '';

  if (database) {
    environment = readSetting(database, ENVIRONMENT_SETTING) ?? environment;
    apiUrl = readSetting(database, API_URL_SETTING) ?? apiUrl;
    applicationId = readEncryptedSetting(database, APPLICATION_ID_SETTING) ?? applicationId;
    apiKey = readEncryptedSetting(database, API_KEY_SETTING) ?? apiKey;
    privateKey = readEncryptedSetting(database, PRIVATE_KEY_SETTING) ?? '';
  }

  return {
    environment: environment.trim(),
    apiUrl: apiUrl.trim(),
    applicationId: applicationId.trim(),
    apiKey: apiKey.trim(),
    privateKey,
    privateKeyPath: config.enableBanking.privateKeyPath
  };
}

export function readEnableBankingSettings(
  database: DatabaseSync
): EnableBankingSettingsResponse {
  const runtime = readEnableBankingRuntimeSettings(database);
  return {
    environment: runtime.environment,
    api_url: runtime.apiUrl,
    application_id_configured: Boolean(runtime.applicationId),
    api_key_configured: Boolean(runtime.apiKey),
    private_key_configured: Boolean(runtime.privateKey) || fs.existsSync(runtime.privateKeyPath)
  };
}

export function saveEnableBankingSettings(
  database: DatabaseSync,
  input: {
    environment?: string;
    apiUrl?: string;
    applicationId?: string;
    apiKey?: string;
    privateKey?: string;
    now: Date;
  }
): EnableBankingSettingsResponse {
  const environment = input.environment?.trim();
  if (environment !== undefined && environment !== 'sandbox' && environment !== 'production') {
    throw new EnableBankingSettingsValidationError('Choose sandbox or production.');
  }

  const apiUrl = input.apiUrl?.trim();
  if (apiUrl !== undefined) validateApiUrl(apiUrl);

  const applicationId = input.applicationId?.trim();
  if (applicationId !== undefined && applicationId.length > MAX_APPLICATION_ID_LENGTH) {
    throw new EnableBankingSettingsValidationError('The Enable Banking application ID is too long.');
  }

  const apiKey = input.apiKey?.trim();
  if (apiKey !== undefined && apiKey.length > MAX_API_KEY_LENGTH) {
    throw new EnableBankingSettingsValidationError('The Enable Banking API key is too long.');
  }

  const privateKey = input.privateKey?.trim();
  if (privateKey !== undefined) {
    if (privateKey.length > MAX_PRIVATE_KEY_LENGTH) {
      throw new EnableBankingSettingsValidationError('The Enable Banking private key is too long.');
    }
    if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(privateKey)) {
      throw new EnableBankingSettingsValidationError('Upload a valid PEM private key.');
    }
  }

  const updatedAt = input.now.toISOString();
  const encryption = createEncryptionService();
  database.exec('BEGIN IMMEDIATE;');
  try {
    if (environment) writeSetting(database, ENVIRONMENT_SETTING, environment, updatedAt);
    if (apiUrl) writeSetting(database, API_URL_SETTING, apiUrl, updatedAt);
    if (applicationId) writeSetting(database, APPLICATION_ID_SETTING, encryption.encrypt(applicationId), updatedAt);
    if (apiKey) writeSetting(database, API_KEY_SETTING, encryption.encrypt(apiKey), updatedAt);
    if (privateKey) writeSetting(database, PRIVATE_KEY_SETTING, encryption.encrypt(privateKey), updatedAt);
    database.exec('COMMIT;');
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve the original database error.
    }
    throw error;
  }

  return readEnableBankingSettings(database);
}

export function validateApiUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new EnableBankingSettingsValidationError('The Enable Banking API URL is invalid.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new EnableBankingSettingsValidationError('The Enable Banking API URL must be HTTP(S) without credentials.');
  }
}

function readEncryptedSetting(database: DatabaseSync, key: string): string | null {
  const value = readSetting(database, key);
  if (!value) return null;
  try {
    return createEncryptionService().decrypt(value);
  } catch {
    return '';
  }
}

function readSetting(database: DatabaseSync, key: string): string | null {
  const row = database.prepare('SELECT value FROM settings WHERE key = ?').get(key) as SettingRow | undefined;
  return typeof row?.value === 'string' ? row.value : null;
}

function writeSetting(database: DatabaseSync, key: string, value: string, updatedAt: string): void {
  database.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, updatedAt);
}

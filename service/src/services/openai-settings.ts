import type { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { createEncryptionService } from '../security/encryption.js';

const OPENAI_API_KEY_SETTING = 'openai.api_key_encrypted';
const OPENAI_MODEL_SETTING = 'openai.model';
const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UNSUPPORTED_MODEL_MARKERS = [
  'audio',
  'computer-use',
  'deep-research',
  'embedding',
  'image',
  'moderation',
  'realtime',
  'search-preview',
  'sora',
  'transcrib',
  'tts',
  'video',
  'whisper'
];

export class OpenAiSettingsValidationError extends Error {}

interface SettingRow {
  value: string;
}

export interface OpenAiRuntimeSettings {
  apiKey: string;
  model: string;
}

export interface OpenAiSettingsResponse {
  api_key_configured: boolean;
  model: string;
}

export interface OpenAiModelsResponse {
  models: Array<{ id: string; label: string }>;
  error: string | null;
}

export function readOpenAiRuntimeSettings(database?: DatabaseSync): OpenAiRuntimeSettings {
  let apiKey = config.secrets.openAiApiKey;
  let model = config.openAiModel;

  if (database) {
    const encryptedApiKey = readSetting(database, OPENAI_API_KEY_SETTING);
    if (encryptedApiKey) {
      try {
        apiKey = createEncryptionService().decrypt(encryptedApiKey);
      } catch {
        apiKey = '';
      }
    }
    model = readSetting(database, OPENAI_MODEL_SETTING) ?? model;
  }

  return {
    apiKey: apiKey.trim(),
    model: model.trim()
  };
}

export function readOpenAiSettings(database: DatabaseSync): OpenAiSettingsResponse {
  const runtime = readOpenAiRuntimeSettings(database);
  return {
    api_key_configured: Boolean(runtime.apiKey),
    model: runtime.model
  };
}

export async function listAvailableOpenAiModels(database: DatabaseSync): Promise<OpenAiModelsResponse> {
  const { apiKey } = readOpenAiRuntimeSettings(database);
  if (!apiKey) return { models: [], error: null };

  let response: Response;
  try {
    response = await fetch(OPENAI_MODELS_URL, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000)
    });
  } catch {
    return { models: [], error: 'OpenAI models could not be loaded.' };
  }
  if (!response.ok) {
    return { models: [], error: `OpenAI models could not be loaded (HTTP ${response.status}).` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { models: [], error: 'OpenAI returned an invalid model list.' };
  }
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as Record<string, unknown>).data)) {
    return { models: [], error: 'OpenAI returned an invalid model list.' };
  }

  const ids = new Set<string>();
  for (const item of (payload as { data: unknown[] }).data) {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : null;
    const id = typeof record?.id === 'string'
      ? record.id.trim()
      : '';
    if (isCompatibleModelId(id)) ids.add(id);
  }
  return {
    models: [...ids].sort((left, right) => left.localeCompare(right)).map((id) => ({ id, label: id })),
    error: null
  };
}

export function saveOpenAiSettings(
  database: DatabaseSync,
  input: { apiKey?: string; model?: string; now: Date }
): OpenAiSettingsResponse {
  const model = input.model?.trim();
  if (model !== undefined && !MODEL_ID_PATTERN.test(model)) {
    throw new OpenAiSettingsValidationError('Choose a valid OpenAI model.');
  }

  const apiKey = input.apiKey?.trim();
  if (apiKey !== undefined && apiKey.length > 500) {
    throw new OpenAiSettingsValidationError('The OpenAI API key is too long.');
  }

  const encryptedApiKey = apiKey
    ? createEncryptionService().encrypt(apiKey)
    : undefined;
  const updatedAt = input.now.toISOString();

  database.exec('BEGIN IMMEDIATE;');
  try {
    if (model) writeSetting(database, OPENAI_MODEL_SETTING, model, updatedAt);
    if (encryptedApiKey) {
      writeSetting(database, OPENAI_API_KEY_SETTING, encryptedApiKey, updatedAt);
    }
    database.exec('COMMIT;');
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve the original database error.
    }
    throw error;
  }

  return readOpenAiSettings(database);
}

function isCompatibleModelId(id: string): boolean {
  if (!MODEL_ID_PATTERN.test(id)) return false;
  const normalized = id.toLowerCase();
  if (UNSUPPORTED_MODEL_MARKERS.some((marker) => normalized.includes(marker))) return false;
  return normalized.startsWith('gpt-')
    || normalized.startsWith('chatgpt-')
    || /^o\d/.test(normalized);
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

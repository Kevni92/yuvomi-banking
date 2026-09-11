import type { DatabaseSync } from 'node:sqlite';
import express from 'express';
import {
  OpenAiSettingsValidationError,
  listAvailableOpenAiModels,
  readOpenAiSettings,
  saveOpenAiSettings
} from '../services/openai-settings.js';
import {
  mutationIsAllowed,
  noStore,
  resolveAuthorizedUser,
  type SessionResolver
} from './route-security.js';

export function createOpenAiSettingsRouter({
  database,
  resolveSession,
  clock = () => new Date()
}: {
  database: DatabaseSync;
  resolveSession: SessionResolver;
  clock?: () => Date;
}): express.Router {
  const router = express.Router();

  router.get('/openai/settings', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;
    noStore(response);
    response.json({ data: readOpenAiSettings(database) });
  });

  router.get('/openai/models', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;
    noStore(response);
    response.json({ data: await listAvailableOpenAiModels(database) });
  });

  router.put('/openai/settings', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user || !mutationIsAllowed(request, response)) return;

    try {
      const body = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new OpenAiSettingsValidationError('OpenAI settings must be a JSON object.');
      }
      const model = (body as Record<string, unknown>).model;
      const apiKey = (body as Record<string, unknown>).api_key;
      if ((model !== undefined && typeof model !== 'string') || (apiKey !== undefined && typeof apiKey !== 'string')) {
        throw new OpenAiSettingsValidationError('OpenAI model and API key have invalid values.');
      }

      noStore(response);
      response.json({
        data: saveOpenAiSettings(database, {
          model,
          apiKey,
          now: clock()
        })
      });
    } catch (error) {
      noStore(response);
      response.status(error instanceof OpenAiSettingsValidationError ? 400 : 503).json({
        error: error instanceof OpenAiSettingsValidationError
          ? error.message
          : 'OpenAI settings could not be stored on this server.'
      });
    }
  });

  return router;
}

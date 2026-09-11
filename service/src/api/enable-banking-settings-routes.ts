import type { DatabaseSync } from 'node:sqlite';
import express from 'express';
import {
  EnableBankingSettingsValidationError,
  readEnableBankingSettings,
  saveEnableBankingSettings
} from '../services/enable-banking-settings.js';
import {
  mutationIsAllowed,
  noStore,
  resolveAuthorizedUser,
  type SessionResolver
} from './route-security.js';

export function createEnableBankingSettingsRouter({
  database,
  resolveSession,
  clock = () => new Date()
}: {
  database: DatabaseSync;
  resolveSession: SessionResolver;
  clock?: () => Date;
}): express.Router {
  const router = express.Router();

  router.get('/enablebanking/settings', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;
    noStore(response);
    response.json({ data: readEnableBankingSettings(database) });
  });

  router.put('/enablebanking/settings', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user || !mutationIsAllowed(request, response)) return;

    try {
      const body = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new EnableBankingSettingsValidationError('Enable Banking settings must be a JSON object.');
      }
      const values = body as Record<string, unknown>;
      const environment = optionalString(values.environment);
      const apiUrl = optionalString(values.api_url);
      const applicationId = optionalString(values.application_id);
      const apiKey = optionalString(values.api_key);
      const privateKey = optionalString(values.private_key);
      if (
        (values.environment !== undefined && environment === undefined)
        || (values.api_url !== undefined && apiUrl === undefined)
        || (values.application_id !== undefined && applicationId === undefined)
        || (values.api_key !== undefined && apiKey === undefined)
        || (values.private_key !== undefined && privateKey === undefined)
      ) {
        throw new EnableBankingSettingsValidationError('Enable Banking settings contain invalid values.');
      }

      noStore(response);
      response.json({
        data: saveEnableBankingSettings(database, {
          environment,
          apiUrl,
          applicationId,
          apiKey,
          privateKey,
          now: clock()
        })
      });
    } catch (error) {
      noStore(response);
      response.status(error instanceof EnableBankingSettingsValidationError ? 400 : 503).json({
        error: error instanceof EnableBankingSettingsValidationError
          ? error.message
          : 'Enable Banking settings could not be stored on this server.'
      });
    }
  });

  return router;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : typeof value === 'string' ? value : undefined;
}

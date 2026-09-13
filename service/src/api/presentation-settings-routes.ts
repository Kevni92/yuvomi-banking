import type { DatabaseSync } from 'node:sqlite';
import express from 'express';
import {
  getPresentationSettings,
  PresentationSettingsValidationError,
  savePresentationSettings
} from '../services/presentation-settings.js';
import {
  mutationIsAllowed,
  noStore,
  resolveAuthorizedUser,
  type SessionResolver
} from './route-security.js';

export function createPresentationSettingsRouter({
  database,
  resolveSession,
  clock = () => new Date()
}: {
  database: DatabaseSync;
  resolveSession: SessionResolver;
  clock?: () => Date;
}): express.Router {
  const router = express.Router();

  router.get('/presentation-settings', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;
    const settings = getPresentationSettings(database, user.id);
    noStore(response);
    response.json({ data: serialize(settings) });
  });

  router.patch('/presentation-settings', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user || !mutationIsAllowed(request, response)) return;
    try {
      const body = objectBody(request.body);
      const settings = savePresentationSettings(
        database,
        user.id,
        body.transaction_title_mode,
        clock()
      );
      noStore(response);
      response.json({ data: serialize(settings) });
    } catch (error) {
      noStore(response);
      response.status(error instanceof PresentationSettingsValidationError ? 400 : 500).json({
        error: error instanceof PresentationSettingsValidationError
          ? error.message
          : 'Presentation settings could not be updated.'
      });
    }
  });

  return router;
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PresentationSettingsValidationError('Presentation settings must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function serialize(settings: ReturnType<typeof getPresentationSettings>): Record<string, unknown> {
  return {
    transaction_title_mode: settings.transactionTitleMode
  };
}

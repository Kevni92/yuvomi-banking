import express, { type Express } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import {
  bankingPermission,
  resolveYuvomiUser,
  type YuvomiUser
} from './auth/yuvomi-session.js';
import { createEnableBankingRouter } from './api/enable-banking-routes.js';
import { createEnableBankingSettingsRouter } from './api/enable-banking-settings-routes.js';
import { createWeeklyBudgetRouter } from './api/weekly-budget-routes.js';
import { createCategoryRouter } from './api/category-routes.js';
import { EnableBankingClient } from './enable-banking/client.js';
import { createCategorizationRouter } from './api/categorization-routes.js';
import { createOpenAiSettingsRouter } from './api/openai-settings-routes.js';
import { OpenAiCategorizer, type CategorizationClient } from './openai/categorizer.js';
import { createPushRouter } from './api/push-routes.js';
import { createTransactionRouter } from './api/transaction-routes.js';
import type { EncryptionService } from './security/encryption.js';

const API_PREFIX = '/api/extensions/banking';

export interface AppDependencies {
  resolveSession?: (cookieHeader?: string) => Promise<YuvomiUser | null>;
  database?: DatabaseSync;
  enableBankingClient?: EnableBankingClient;
  categorizationClient?: CategorizationClient;
  encryption?: EncryptionService;
  clock?: () => Date;
}

function setNoStore(response: express.Response): void {
  response.setHeader('Cache-Control', 'no-store');
}

export function createApp({
  resolveSession = resolveYuvomiUser,
  database,
  enableBankingClient,
  categorizationClient,
  encryption,
  clock = () => new Date()
}: AppDependencies = {}): Express {
  const app = express();
  const resolvedEnableBankingClient = enableBankingClient ?? new EnableBankingClient({ database });
  const resolvedCategorizationClient = categorizationClient ?? new OpenAiCategorizer(database);

  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get(`${API_PREFIX}/health`, (_request, response) => {
    setNoStore(response);
    response.json({
      ok: true,
      service: 'yuvomi-banking',
      version: '0.1.0'
    });
  });

  app.get(`${API_PREFIX}/me`, async (request, response) => {
    setNoStore(response);

    try {
      const user = await resolveSession(request.get('cookie') ?? undefined);

      if (!user) {
        response.status(401).json({ error: 'Not authenticated.' });
        return;
      }

      const permission = bankingPermission(user);

      if (permission === 'none') {
        response.status(403).json({ error: 'Banking module access denied.' });
        return;
      }

      response.json({
        data: {
          id: user.id,
          display_name: user.display_name ?? null,
          role: user.role ?? null,
          banking_permission: permission
        }
      });
    } catch {
      // Do not expose upstream URLs, response bodies, cookies, or other
      // implementation details to the browser.
      response.status(502).json({ error: 'Unable to verify Yuvomi session.' });
    }
  });

  if (database) {
    app.use(`${API_PREFIX}`, createEnableBankingRouter({
      database,
      client: resolvedEnableBankingClient,
      resolveSession
    }));
    app.use(`${API_PREFIX}`, createEnableBankingSettingsRouter({ database, resolveSession, clock }));
    app.use(`${API_PREFIX}`, createWeeklyBudgetRouter({
      database,
      resolveSession,
      clock
    }));
    app.use(`${API_PREFIX}`, createCategoryRouter({ database, resolveSession, clock }));
    app.use(`${API_PREFIX}`, createCategorizationRouter({
      database,
      resolveSession,
      categorizer: resolvedCategorizationClient,
      clock
    }));
    app.use(`${API_PREFIX}`, createOpenAiSettingsRouter({ database, resolveSession, clock }));
    app.use(`${API_PREFIX}`, createTransactionRouter({
      database, resolveSession, encryption, client: resolvedEnableBankingClient
    }));
    app.use(`${API_PREFIX}`, createPushRouter({ database, resolveSession, clock }));
  }

  return app;
}

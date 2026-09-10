import express, { type Express } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import {
  bankingPermission,
  resolveYuvomiUser,
  type YuvomiUser
} from './auth/yuvomi-session.js';
import { createEnableBankingRouter } from './api/enable-banking-routes.js';
import { EnableBankingClient } from './enable-banking/client.js';

const API_PREFIX = '/api/extensions/banking';

export interface AppDependencies {
  resolveSession?: (cookieHeader?: string) => Promise<YuvomiUser | null>;
  database?: DatabaseSync;
  enableBankingClient?: EnableBankingClient;
}

function setNoStore(response: express.Response): void {
  response.setHeader('Cache-Control', 'no-store');
}

export function createApp({
  resolveSession = resolveYuvomiUser,
  database,
  enableBankingClient = new EnableBankingClient()
}: AppDependencies = {}): Express {
  const app = express();

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
      client: enableBankingClient,
      resolveSession
    }));
  }

  return app;
}

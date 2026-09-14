import 'dotenv/config';

import { createApp } from './app.js';
import { config } from './config.js';
import { openBankingDatabase } from './db/database.js';
import { createEncryptionService } from './security/encryption.js';
import { backfillPayees } from './cli/payee-backfill.js';
import { EnableBankingClient } from './enable-banking/client.js';
import { startWeeklyBudgetScheduler } from './services/weekly-budget-scheduler.js';
import {
  configuredVapidDetails,
  startPushDeliveryWorker,
  VapidPushSender
} from './services/push-delivery-worker.js';

if (process.argv.includes('--backfill-payees')) {
  const database = openBankingDatabase();
  try {
    const result = backfillPayees({
      database,
      encryption: createEncryptionService(),
      hmacSecret: config.secrets.counterpartyHmac,
      apply: process.argv.includes('--apply')
    });
    console.log(JSON.stringify({ mode: process.argv.includes('--apply') ? 'apply' : 'dry-run', ...result }));
  } catch {
    console.error('Payee backfill failed.');
    process.exitCode = 1;
  } finally {
    database.close();
  }
} else {
  const database = openBankingDatabase();
  const enableBankingClient = new EnableBankingClient({ database });
  const weeklyBudgetScheduler = startWeeklyBudgetScheduler({
    database,
    client: enableBankingClient,
    onTickError: () => {
      console.error('Yuvomi Banking scheduler tick failed.');
    }
  });
  const configuredVapid = configuredVapidDetails();
  const pushDeliveryWorker = configuredVapid
    ? startPushDeliveryWorker({
        database,
        sender: new VapidPushSender(configuredVapid),
        onTickError: () => {
          console.error('Yuvomi Banking push delivery tick failed.');
        }
      })
    : null;

  const app = createApp({ database, enableBankingClient });
  const server = app.listen(config.port, config.host, () => {
    console.log(`Yuvomi Banking Sidecar listening on http://${config.host}:${config.port}`);
  });

  server.once('error', () => {
    weeklyBudgetScheduler.stop();
    pushDeliveryWorker?.stop();
    database.close();
    process.exitCode = 1;
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      weeklyBudgetScheduler.stop();
      pushDeliveryWorker?.stop();
      server.close(() => {
        database.close();
        process.exit(0);
      });
    });
  }
}

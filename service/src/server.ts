import 'dotenv/config';

import { createApp } from './app.js';
import { config } from './config.js';
import { openBankingDatabase } from './db/database.js';
import { EnableBankingClient } from './enable-banking/client.js';
import { startWeeklyBudgetScheduler } from './services/weekly-budget-scheduler.js';
import {
  configuredVapidDetails,
  startPushDeliveryWorker,
  VapidPushSender
} from './services/push-delivery-worker.js';

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

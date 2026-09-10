import 'dotenv/config';

import { createApp } from './app.js';
import { config } from './config.js';
import { openBankingDatabase } from './db/database.js';
import { EnableBankingClient } from './enable-banking/client.js';
import { startWeeklyBudgetScheduler } from './services/weekly-budget-scheduler.js';

const database = openBankingDatabase();
const enableBankingClient = new EnableBankingClient();
const weeklyBudgetScheduler = startWeeklyBudgetScheduler({
  database,
  client: enableBankingClient,
  onTickError: () => {
    console.error('Yuvomi Banking scheduler tick failed.');
  }
});

const app = createApp({ database, enableBankingClient });
const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`Yuvomi Banking Sidecar listening on http://127.0.0.1:${config.port}`);
});

server.once('error', () => {
  weeklyBudgetScheduler.stop();
  database.close();
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    weeklyBudgetScheduler.stop();
    server.close(() => {
      database.close();
      process.exit(0);
    });
  });
}

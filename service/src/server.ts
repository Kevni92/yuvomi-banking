import 'dotenv/config';

import { createApp } from './app.js';
import { config } from './config.js';
import { openBankingDatabase } from './db/database.js';
import { EnableBankingClient } from './enable-banking/client.js';

const database = openBankingDatabase();

const app = createApp({ database, enableBankingClient: new EnableBankingClient() });
const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`Yuvomi Banking Sidecar listening on http://127.0.0.1:${config.port}`);
});

server.once('error', () => {
  database.close();
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => {
      database.close();
      process.exit(0);
    });
  });
}

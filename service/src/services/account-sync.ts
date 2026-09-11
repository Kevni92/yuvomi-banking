import type { DatabaseSync } from 'node:sqlite';
import type { EnableBankingClient, TransactionQuery } from '../enable-banking/client.js';
import { importTransactions, type ProviderTransaction } from '../enable-banking/importer.js';
import type { EncryptionService } from '../security/encryption.js';
import { enrichAccountTransactions, type EnrichAccountTransactionsResult } from './transaction-enrichment.js';

export async function syncBankAccount({
  database, client, accountId, providerAccountId, hmacSecret, encryption, query = {}, now = new Date(), maxDetails
}: {
  database: DatabaseSync;
  client: EnableBankingClient;
  accountId: number;
  providerAccountId: string;
  hmacSecret: string;
  encryption: EncryptionService;
  query?: Omit<TransactionQuery, 'continuationKey'>;
  now?: Date;
  maxDetails?: number;
}): Promise<{ pages: number; imported: { inserted: number; updated: number }; enrichment: EnrichAccountTransactionsResult }> {
  const provider = await client.getAllAccountTransactions(providerAccountId, query);
  const imported = importTransactions({
    database, accountId, transactions: provider.transactions as ProviderTransaction[], hmacSecret, encryption
  });
  const timestamp = now.toISOString();
  database.prepare('UPDATE bank_accounts SET last_synced_at = ?, updated_at = ? WHERE id = ?')
    .run(timestamp, timestamp, accountId);
  const enrichment = await enrichAccountTransactions({
    database, client, accountId, providerAccountId, encryption, now, maxDetails
  });
  return { pages: provider.pages, imported, enrichment };
}

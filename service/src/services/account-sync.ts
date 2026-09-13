import type { DatabaseSync } from 'node:sqlite';
import type { EnableBankingClient, TransactionQuery } from '../enable-banking/client.js';
import { importTransactions, type ProviderTransaction } from '../enable-banking/importer.js';
import type { EncryptionService } from '../security/encryption.js';
import { applyCategoryRulesForAccount } from './category-rules.js';
import { enrichAccountTransactions, type EnrichAccountTransactionsResult } from './transaction-enrichment.js';
import { captureProviderObservationsForAccount } from './transaction-observations.js';
import { resolveTransactionsForAccount } from './transaction-resolution.js';

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
  const providerTransactions = provider.transactions as ProviderTransaction[];
  const imported = importTransactions({
    database, accountId, transactions: providerTransactions, hmacSecret, encryption
  });

  // Preserve the exact provider-visible identity state after reconciliation.
  // A later BOOK response may replace a useful PDNG merchant descriptor with a
  // settlement bank or processor; observations keep both states on one local
  // canonical transaction.
  captureProviderObservationsForAccount({
    database,
    accountId,
    transactions: providerTransactions,
    now
  });

  const timestamp = now.toISOString();
  database.prepare('UPDATE bank_accounts SET last_synced_at = ?, updated_at = ? WHERE id = ?')
    .run(timestamp, timestamp, accountId);
  const enrichment = await enrichAccountTransactions({
    database, client, accountId, providerAccountId, encryption, now, maxDetails
  });

  // Run the identity resolver after provider-detail enrichment so list data,
  // historical PDNG observations and detail payloads can all contribute.
  resolveTransactionsForAccount({
    database,
    accountId,
    encryption,
    hmacSecret,
    now
  });
  // Merchant rules may become matchable only after identity resolution.
  applyCategoryRulesForAccount(database, accountId, now);

  return { pages: provider.pages, imported, enrichment };
}

import type { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { config } from '../config.js';
import {
  parseTransactionQuery,
  getTransactionDetail,
  queryTransactions,
  TransactionQueryValidationError
} from '../services/transactions-query.js';
import { decorateTransactionListMetadata } from '../services/transaction-list-metadata.js';
import type { EncryptionService } from '../security/encryption.js';
import { createEncryptionService } from '../security/encryption.js';
import type { EnableBankingClient } from '../enable-banking/client.js';
import { enrichTransactionById } from '../services/transaction-enrichment.js';
import { resolveTransactionById } from '../services/transaction-resolution.js';
import { resolvePayeeForTransaction, applyPayeeCategoriesForAccount } from '../services/recurring-payees.js';
import { applyCategoryRulesForAccount } from '../services/category-rules.js';
import {
  noStore,
  mutationIsAllowed,
  resolveAuthorizedUser,
  type SessionResolver
} from './route-security.js';

export function createTransactionRouter({
  database,
  resolveSession,
  encryption,
  client
}: {
  database: DatabaseSync;
  resolveSession: SessionResolver;
  encryption?: EncryptionService;
  client: EnableBankingClient;
}): express.Router {
  const router = express.Router();

  router.get('/transactions', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;

    try {
      const query = parseTransactionQuery(user.id, request.query as Record<string, unknown>);
      const result = queryTransactions(database, query);
      const transactions = decorateTransactionListMetadata(database, user.id, result.transactions);
      noStore(response);
      response.json({
        data: {
          transactions,
          pagination: {
            total: result.total,
            limit: result.limit,
            offset: result.offset
          }
        }
      });
    } catch (error) {
      if (error instanceof TransactionQueryValidationError) {
        noStore(response);
        response.status(400).json({ error: error.message });
        return;
      }
      noStore(response);
      response.status(500).json({ error: 'Transactions could not be loaded.' });
    }
  });

  router.get('/transactions/:transactionId', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;
    const transactionId = positivePathId(request.params.transactionId);
    if (!transactionId) {
      noStore(response);
      response.status(404).json({ error: 'Transaction not found.' });
      return;
    }

    try {
      const detail = getTransactionDetail(database, user.id, transactionId, encryption ?? createEncryptionService());
      noStore(response);
      if (!detail) {
        response.status(404).json({ error: 'Transaction not found.' });
        return;
      }
      response.json({ data: detail });
    } catch {
      noStore(response);
      response.status(500).json({ error: 'Transaction details could not be loaded.' });
    }
  });

  router.post('/transactions/:transactionId/enrich', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user || !mutationIsAllowed(request, response)) return;
    const transactionId = positivePathId(request.params.transactionId);
    if (!transactionId) {
      noStore(response);
      response.status(404).json({ error: 'Transaction not found.' });
      return;
    }
    const resolvedEncryption = encryption ?? createEncryptionService();
    // The detail query is also the ownership guard. Provider IDs never come from the browser.
    if (!getTransactionDetail(database, user.id, transactionId, resolvedEncryption)) {
      noStore(response);
      response.status(404).json({ error: 'Transaction not found.' });
      return;
    }
    try {
      const result = await enrichTransactionById({
        database, client, transactionId, encryption: resolvedEncryption
      });
      resolveTransactionById({
        database,
        transactionId,
        encryption: resolvedEncryption,
        hmacSecret: config.secrets.counterpartyHmac,
        now: new Date()
      });
      const payeeResolution = resolvePayeeForTransaction({
        database,
        transactionId,
        encryption: resolvedEncryption,
        hmacSecret: config.secrets.counterpartyHmac,
        now: new Date()
      });
      const transactionRow = database.prepare('SELECT account_id FROM transactions WHERE id = ?').get(transactionId) as { account_id: number } | undefined;
      if (transactionRow) {
        applyCategoryRulesForAccount(database, Number(transactionRow.account_id), new Date());
        applyPayeeCategoriesForAccount(database, Number(transactionRow.account_id), new Date());
      }
      const detail = getTransactionDetail(database, user.id, transactionId, resolvedEncryption);
      noStore(response);
      response.json({ data: {
        detail_available: result.detailAvailable,
        detail_fetched: result.detailFetched,
        merchant_resolved: Boolean(detail?.transaction.merchant_name) || result.merchantResolved,
        merchant_name: detail?.transaction.merchant_name ?? null,
        provider_detail_state: result.state,
        payee_match_state: payeeResolution.matched || payeeResolution.created ? 'matched' : payeeResolution.ambiguous ? 'ambiguous' : null
      } });
    } catch {
      noStore(response);
      response.status(502).json({ error: 'Provider transaction details could not be loaded.' });
    }
  });

  return router;
}

function positivePathId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

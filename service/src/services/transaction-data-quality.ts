import type { DatabaseSync } from 'node:sqlite';

export interface TransactionDataQuality {
  transactions_total: number;
  with_counterparty_name: number;
  with_purpose: number;
  with_mcc: number;
  with_transaction_id: number;
  with_detail_payload: number;
  with_resolved_merchant: number;
}

export function transactionDataQuality(database: DatabaseSync, accountId: number, limit = 100): TransactionDataQuality {
  const row = database.prepare(`
    SELECT COUNT(*) AS transactions_total,
      SUM(CASE WHEN counterparty_name IS NOT NULL AND counterparty_name <> '' THEN 1 ELSE 0 END) AS with_counterparty_name,
      SUM(CASE WHEN purpose IS NOT NULL AND purpose <> '' THEN 1 ELSE 0 END) AS with_purpose,
      SUM(CASE WHEN mcc IS NOT NULL AND mcc <> '' THEN 1 ELSE 0 END) AS with_mcc,
      SUM(CASE WHEN transaction_id IS NOT NULL AND transaction_id <> '' THEN 1 ELSE 0 END) AS with_transaction_id,
      SUM(CASE WHEN provider_detail_state = 'fetched' THEN 1 ELSE 0 END) AS with_detail_payload,
      SUM(CASE WHEN merchant_key IS NOT NULL AND merchant_key <> '' THEN 1 ELSE 0 END) AS with_resolved_merchant
    FROM (
      SELECT * FROM transactions WHERE account_id = ? AND status = 'BOOK'
      ORDER BY COALESCE(booking_date, value_date, transaction_date) DESC, id DESC LIMIT ?
    )
  `).get(accountId, limit) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value ?? 0)])) as unknown as TransactionDataQuality;
}

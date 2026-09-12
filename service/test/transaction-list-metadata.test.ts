import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  decorateTransactionListMetadata,
  inferTransactionTime,
  isAtOrAfter
} from '../src/services/transaction-list-metadata.js';
import type { PublicTransaction } from '../src/services/transactions-query.js';

function transaction(id: number, purpose: string): PublicTransaction {
  return {
    id,
    account_id: 1,
    booking_date: '2026-09-11',
    value_date: null,
    transaction_date: null,
    amount: '1.00',
    currency: 'EUR',
    direction: 'outgoing',
    counterparty_name: null,
    purpose,
    merchant_name: null,
    merchant_key: null,
    merchant_logo_available: 0,
    status: 'BOOK',
    category_id: null,
    category_name: null,
    category_icon: null,
    category_color: null,
    category_source: null,
    category_confidence: null,
    weekly_budget_override: 'inherit',
    category_weekly_budget_default: null,
    weekly_budget_selected: 0
  };
}

test('transaction time is exposed only when provider text contains reliable time evidence', () => {
  assert.equal(inferTransactionTime(transaction(1, '2026-09-09T07:51 Debit.16 2030-12 Zahl.System')), '07:51');
  assert.equal(inferTransactionTime(transaction(2, '10.09/14.38UHR LAMBRECHT')), '14:38');
  assert.equal(inferTransactionTime(transaction(3, '04.09.26 15.31.45 KARTENZAHLUNG')), '15:31');
  assert.equal(inferTransactionTime(transaction(4, 'Normale Buchung ohne Uhrzeit')), null);
});

test('list metadata marks only transactions first imported by the latest successful account sync', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE enable_banking_connections (
      id INTEGER PRIMARY KEY,
      yuvomi_user_id INTEGER NOT NULL
    );
    CREATE TABLE bank_accounts (
      id INTEGER PRIMARY KEY,
      connection_id INTEGER NOT NULL,
      last_synced_at TEXT
    );
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO enable_banking_connections (id, yuvomi_user_id) VALUES (1, 7), (2, 8);
    INSERT INTO bank_accounts (id, connection_id, last_synced_at)
      VALUES (1, 1, '2026-09-12T06:00:00.000Z'),
             (2, 2, '2026-09-12T06:00:00.000Z');
    INSERT INTO transactions (id, account_id, created_at)
      VALUES (1, 1, '2026-09-12T06:00:01.000Z'),
             (2, 1, '2026-09-11T20:00:00.000Z'),
             (3, 2, '2026-09-12T06:00:02.000Z');
  `);

  const decorated = decorateTransactionListMetadata(database, 7, [
    transaction(1, '10.09/14.38UHR LAMBRECHT'),
    transaction(2, 'Alt')
  ]);
  assert.equal(decorated[0].new_since_last_sync, 1);
  assert.equal(decorated[0].transaction_time, '14:38');
  assert.equal(decorated[1].new_since_last_sync, 0);
  assert.equal(isAtOrAfter('2026-09-12T06:00:00.000Z', '2026-09-12T06:00:00.000Z'), true);
  assert.equal(isAtOrAfter('2026-09-12T05:59:59.999Z', '2026-09-12T06:00:00.000Z'), false);
  database.close();
});

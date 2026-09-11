import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  latestUsableBalanceSnapshot,
  normalizeAndSelectBalances,
  persistAccountBalanceSnapshots
} from '../src/enable-banking/balances.js';
import { migrateDatabase } from '../src/db/database.js';

test('selects an interim available balance ahead of booked and unknown balances', () => {
  const balances = normalizeAndSelectBalances([
    {
      balance_amount: { amount: '101.25', currency: 'EUR' },
      balance_type: 'CLBD',
      reference_date: '2026-09-09'
    },
    {
      balance_amount: { amount: '99.95', currency: 'EUR' },
      balance_type: 'ITAV',
      last_change_date_time: '2026-09-10T10:15:00+02:00'
    },
    {
      balance_amount: { amount: '999.00', currency: 'EUR' },
      balance_type: 'OTHR'
    }
  ]);

  assert.equal(balances.length, 3);
  assert.deepEqual(balances.filter((balance) => balance.usableForWeeklyBudget), [{
    providerBalanceType: 'ITAV',
    normalizedBalanceType: 'interim_available',
    amountCents: 9995,
    currency: 'EUR',
    observedAt: '2026-09-10T08:15:00.000Z',
    usableForWeeklyBudget: true
  }]);
});

test('supports camel-case responses and applies debit balance direction', () => {
  assert.deepEqual(normalizeAndSelectBalances([{
    balanceAmount: { amount: '20.00', currency: 'EUR' },
    creditDebitIndicator: 'DBIT',
    balanceType: 'CLAV',
    referenceDate: '2026-09-10'
  }]), [{
    providerBalanceType: 'CLAV',
    normalizedBalanceType: 'available',
    amountCents: -2000,
    currency: 'EUR',
    observedAt: '2026-09-10',
    usableForWeeklyBudget: true
  }]);
});

test('never selects unsupported or wrong-currency balances', () => {
  const balances = normalizeAndSelectBalances([
    {
      balance_amount: { amount: '200.00', currency: 'EUR' },
      balance_type: 'FWAV'
    },
    {
      balance_amount: { amount: '100.00', currency: 'USD' },
      balance_type: 'ITAV'
    }
  ]);
  assert.equal(balances.some((balance) => balance.usableForWeeklyBudget), false);
});

test('deduplicates repeated provider types using the latest observation', () => {
  const balances = normalizeAndSelectBalances([
    {
      balance_amount: { amount: '80.00', currency: 'EUR' },
      balance_type: 'ITAV',
      last_change_date_time: '2026-09-10T08:00:00Z'
    },
    {
      balance_amount: { amount: '90.00', currency: 'EUR' },
      balance_type: 'ITAV',
      last_change_date_time: '2026-09-10T09:00:00Z'
    }
  ]);
  assert.equal(balances.length, 1);
  assert.equal(balances[0].amountCents, 9000);
});

test('persists balance batches and returns the latest selected snapshot', () => {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  database.prepare(`
    INSERT INTO enable_banking_connections (yuvomi_user_id, status, created_at, updated_at)
    VALUES (7, 'authorized', '2026-09-10', '2026-09-10')
  `).run();
  database.prepare(`
    INSERT INTO bank_accounts (
      connection_id, provider_account_id, currency, created_at, updated_at
    ) VALUES (1, 'budget-provider', 'EUR', '2026-09-10', '2026-09-10')
  `).run();

  const first = persistAccountBalanceSnapshots({
    database,
    accountId: 1,
    syncRunKey: 'balance-run-1',
    fetchedAt: new Date('2026-09-10T06:00:00Z'),
    balances: [{
      balance_amount: { amount: '100.00', currency: 'EUR' },
      balance_type: 'ITAV'
    }]
  });
  assert.equal(first.usableBalance?.amountCents, 10000);

  persistAccountBalanceSnapshots({
    database,
    accountId: 1,
    syncRunKey: 'balance-run-2',
    fetchedAt: new Date('2026-09-10T18:00:00Z'),
    balances: [{
      balance_amount: { amount: '75.50', currency: 'EUR' },
      balance_type: 'ITAV'
    }]
  });
  const latest = latestUsableBalanceSnapshot(database, 1);
  assert.equal(latest?.amountCents, 7550);
  assert.equal(latest?.syncRunKey, 'balance-run-2');
  assert.equal(database.prepare(
    'SELECT count(*) AS count FROM account_balance_snapshots'
  ).get()?.count, 2);
  database.close();
});

test('rejects fractional cents instead of rounding financial values', () => {
  assert.throws(() => normalizeAndSelectBalances([{
    balance_amount: { amount: '1.001', currency: 'EUR' },
    balance_type: 'ITAV'
  }]), /unsupported precision/);
});

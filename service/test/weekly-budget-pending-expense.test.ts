import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { evaluateDirectExpense } from '../src/services/weekly-budget.js';

const candidate = {
  accountId: 1,
  sourceAccountId: 1,
  direction: 'outgoing' as const,
  currency: 'EUR',
  amountCents: 1832,
  bookingDate: '2026-09-14',
  valueDate: null,
  transactionDate: null,
  transactionOverride: 'inherit' as const,
  categoryDefault: true,
  isInternalTransfer: false,
  isRefillTransfer: false,
  periodStartDate: '2026-09-11',
  periodEndDate: '2026-09-18'
};

test('pending selected main-account transactions count as provisional direct expenses', () => {
  const result = evaluateDirectExpense({ ...candidate, status: 'PDNG' });
  assert.equal(result.included, true);
  assert.equal(result.amountCents, 1832);
  assert.equal(result.exclusionReason, null);
  assert.equal(result.decision.source, 'category_default');
});

test('unknown-status transactions remain excluded from direct expenses', () => {
  const result = evaluateDirectExpense({ ...candidate, status: 'UNKNOWN' });
  assert.equal(result.included, false);
  assert.equal(result.exclusionReason, 'not_booked');
});

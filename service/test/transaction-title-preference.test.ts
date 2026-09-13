import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { resolveTransactionDisplayTitle } from '../src/services/presentation-settings.js';
import { deriveTransactionSemantics } from '../src/services/transaction-semantics.js';

const base = {
  merchant_name: null,
  merchant_key: null,
  merchant_logo_available: 0,
  counterparty_name: null,
  purpose: null
};

test('smart transaction titles prefer operation semantics when no merchant identity is verified', () => {
  const cash = deriveTransactionSemantics({ description: 'BARGELDAUSZAHLUNG', code: 'NMSC+083+2239+003' });
  assert.equal(resolveTransactionDisplayTitle({
    ...base,
    merchant_name: 'GA NR00002239 BLZ54651240 1',
    counterparty_name: 'GA NR00002239 BLZ54651240 1'
  }, cash, 'smart'), 'Bargeldauszahlung');

  const applePay = deriveTransactionSemantics({ description: 'E-COM (APPLE PAY)', code: 'NDDT+106+9248+011' });
  const unverifiedSettlementParty = {
    ...base,
    merchant_name: 'Example Settlement Clearing AG',
    counterparty_name: 'Example Settlement Clearing AG'
  };
  assert.equal(resolveTransactionDisplayTitle(unverifiedSettlementParty, applePay, 'smart'), 'Apple Pay');
  assert.equal(resolveTransactionDisplayTitle(unverifiedSettlementParty, applePay, 'counterparty'), 'Example Settlement Clearing AG');
  assert.equal(resolveTransactionDisplayTitle(unverifiedSettlementParty, applePay, 'transaction_type'), 'Apple Pay');

  assert.equal(resolveTransactionDisplayTitle({
    ...base,
    merchant_name: 'MO 56005568 120926141638C16',
    counterparty_name: 'MO 56005568 120926141638C16'
  }, applePay, 'smart'), 'Apple Pay');
});

test('verified merchant evidence wins even when the merchant name looks like a financial institution', () => {
  const applePay = deriveTransactionSemantics({ description: 'E-COM (APPLE PAY)' });
  const transaction = {
    ...base,
    merchant_name: 'Example Bank AG',
    counterparty_name: 'Example Bank AG'
  };
  assert.equal(resolveTransactionDisplayTitle(transaction, applePay, 'smart', {
    resolutionMethod: 'provider_explicit',
    evidenceSource: 'detail.card_acceptor_name'
  }), 'Example Bank AG');
});

test('smart transaction titles keep known merchants while explicit modes remain selectable', () => {
  const card = deriveTransactionSemantics({ description: 'E-COM (APPLE PAY)' });
  const transaction = {
    ...base,
    merchant_name: 'Lidl',
    merchant_key: 'lidl',
    merchant_logo_available: 1,
    counterparty_name: 'Lidl'
  };
  assert.equal(resolveTransactionDisplayTitle(transaction, card, 'smart'), 'Lidl');
  assert.equal(resolveTransactionDisplayTitle(transaction, card, 'counterparty'), 'Lidl');
  assert.equal(resolveTransactionDisplayTitle(transaction, card, 'transaction_type'), 'Apple Pay');
});

test('ordinary transfer counterparties are not suppressed by name heuristics', () => {
  const transfer = deriveTransactionSemantics({ description: 'SEPA TRANSFER' });
  const transaction = {
    ...base,
    counterparty_name: 'Example Bank AG'
  };
  assert.equal(resolveTransactionDisplayTitle(transaction, transfer, 'smart'), 'Example Bank AG');
});

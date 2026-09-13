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

test('smart transaction titles replace technical ATM and processor names with useful bank semantics', () => {
  const cash = deriveTransactionSemantics({ description: 'BARGELDAUSZAHLUNG', code: 'NMSC+083+2239+003' });
  assert.equal(resolveTransactionDisplayTitle({
    ...base,
    merchant_name: 'GA NR00002239 BLZ54651240 1',
    counterparty_name: 'GA NR00002239 BLZ54651240 1'
  }, cash, 'smart'), 'Bargeldauszahlung');

  const applePay = deriveTransactionSemantics({ description: 'E-COM (APPLE PAY)', code: 'NDDT+106+9248+011' });
  assert.equal(resolveTransactionDisplayTitle({
    ...base,
    merchant_name: 'Landesbank Hessen-Thuringen',
    counterparty_name: 'Landesbank Hessen-Thuringen'
  }, applePay, 'smart'), 'E-COM (Apple Pay)');
});

test('smart transaction titles keep real merchants while explicit modes remain selectable', () => {
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
  assert.equal(resolveTransactionDisplayTitle(transaction, card, 'transaction_type'), 'E-COM (Apple Pay)');
});

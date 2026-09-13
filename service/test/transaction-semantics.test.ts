import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { deriveTransactionSemantics } from '../src/services/transaction-semantics.js';

test('bank transaction descriptions expose card-payment and cash-withdrawal semantics', () => {
  assert.deepEqual(deriveTransactionSemantics({
    description: 'E-COM (APPLE PAY)',
    code: 'NDDT+106+9248+011',
    sub_code: null
  }), {
    kind: 'card_payment',
    label: 'Kartenzahlung',
    description: 'E-COM (APPLE PAY)',
    paymentMethod: 'Apple Pay',
    displayLabel: 'Kartenzahlung · Apple Pay',
    preferDisplay: true,
    categoryHint: null
  });

  assert.deepEqual(deriveTransactionSemantics(JSON.stringify({
    description: 'BARGELDAUSZAHLUNG',
    code: 'NMSC+083+2239+003',
    sub_code: null
  })), {
    kind: 'cash_withdrawal',
    label: 'Bargeldabhebung',
    description: 'BARGELDAUSZAHLUNG',
    paymentMethod: null,
    displayLabel: 'Bargeldabhebung',
    preferDisplay: true,
    categoryHint: 'Bargeld'
  });
});

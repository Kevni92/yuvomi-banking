import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  extractPayeeIdentifiers,
  hashPayeeIdentifier,
  normalizePayeeIdentifier
} from '../src/services/payee-identifiers.js';

const SECRET = 'payee-identifier-test-secret';
const IBAN = 'DE89370400440532013000';

test('uses domain-separated hashes and conservative identifier normalization', () => {
  const normalized = normalizePayeeIdentifier('counterparty_iban', 'de89 3704 0044 0532 0130 00');
  assert.equal(normalized, IBAN);
  assert.notEqual(
    hashPayeeIdentifier('counterparty_iban', IBAN, SECRET),
    hashPayeeIdentifier('merchant_key', IBAN, SECRET)
  );
  assert.equal(normalizePayeeIdentifier('counterparty_iban', 'not-an-iban'), null);
});

test('accepts only explicitly labelled creditor IDs and allowlisted account schemes', () => {
  const evidence = extractPayeeIdentifiers({
    counterpartyName: 'Example Energie',
    providerRecords: [{
      creditor: { name: 'Example Energie' },
      creditor_account: { iban: IBAN },
      creditor_id: 'DE98ZZZ09999999999',
      creditor_account_additional_identification: {
        scheme_name: 'BBAN', identification: '123456789'
      },
      remittance_information: ['Gläubiger-ID: DE98ZZZ09999999999 Mandatsreferenz ABC123']
    }]
  });
  assert.deepEqual(evidence.map((item) => item.identifierType), [
    'counterparty_iban', 'sepa_creditor_id', 'account_additional_id', 'counterparty_name'
  ]);
  assert.equal(evidence.some((item) => item.normalizedValue.includes('ABC123')), false);
  assert.equal(extractPayeeIdentifiers({
    counterpartyName: 'Example',
    providerRecords: [{ creditor_account_additional_identification: { scheme_name: 'UNKNOWN', identification: 'secret' } }]
  }).some((item) => item.identifierType === 'account_additional_id'), false);
});

test('does not turn a payment processor into a reusable payee', () => {
  const evidence = extractPayeeIdentifiers({
    counterpartyId: 'legacy-processor-hmac',
    counterpartyName: 'PayPal Europe S.a.r.l.',
    providerRecords: [{ creditor: { name: 'PayPal Europe S.a.r.l.' }, creditor_account: { iban: IBAN } }]
  });
  assert.deepEqual(evidence.map((item) => item.identifierType), []);
});

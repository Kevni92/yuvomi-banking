import assert from 'node:assert/strict';
import test from 'node:test';
import { createEncryptionService } from '../src/security/encryption.js';
import { resolveMerchantFromEvidence } from '../src/services/merchants.js';
import {
  mergeDetailPayload,
  mergeListPayload,
  readStoredProviderPayload,
  writeStoredProviderPayload
} from '../src/services/provider-transaction-payload.js';
import { collectTransactionEvidence } from '../src/services/transaction-evidence.js';

const encryption = createEncryptionService('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');

test('keeps list and detail provider payloads in one encrypted versioned envelope', () => {
  const list = { note: 'POS LIDL 0123' };
  const listPayload = mergeListPayload(null, list, '2026-01-01T00:00:00.000Z');
  const encrypted = writeStoredProviderPayload(listPayload, encryption);
  assert.ok(!encrypted.includes('LIDL'));
  const merged = mergeDetailPayload(
    readStoredProviderPayload(encrypted, encryption), { reference_number: 'detail-reference' }, '2026-01-02T00:00:00.000Z'
  );
  assert.deepEqual(merged.list, list);
  assert.deepEqual(merged.detail, { reference_number: 'detail-reference' });
});

test('collects known and proprietary merchant evidence without guessing from MCC', () => {
  const evidence = collectTransactionEvidence(
    { merchant_category_code: '5411' },
    { bank_specific: { pos_information: 'LIDL DE1234' } }
  );
  const resolved = resolveMerchantFromEvidence(evidence);
  assert.deepEqual(resolved, {
    merchant: { key: 'lidl', name: 'Lidl' },
    source: 'detail.raw_alias_scan',
    method: 'registry_alias'
  });
  assert.equal(resolveMerchantFromEvidence(collectTransactionEvidence({ merchant_category_code: '5411' })), null);
});

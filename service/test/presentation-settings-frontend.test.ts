import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = path.resolve(here, '../../../modules/banking');
const entry = fs.readFileSync(path.join(moduleRoot, 'entry.js'), 'utf8');
const settings = fs.readFileSync(path.join(moduleRoot, 'presentation-settings.js'), 'utf8');

test('banking settings expose configurable transaction-title behavior', () => {
  assert.match(entry, /installPresentationSettings/);
  assert.match(settings, /presentation-settings/);
  assert.match(settings, /value="smart"/);
  assert.match(settings, /value="counterparty"/);
  assert.match(settings, /value="transaction_type"/);
  assert.match(settings, /Intelligent \(empfohlen\)/);
  assert.match(settings, /x-banking-csrf/);
});

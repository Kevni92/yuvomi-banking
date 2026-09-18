import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { effectiveRemainingBudgetCents } from '../src/services/push-outbox.js';

test('daily weekly-budget notification uses effective remaining budget after direct expenses', () => {
  assert.equal(effectiveRemainingBudgetCents(14315, 13239), 1076);
  assert.equal(effectiveRemainingBudgetCents(20866, 13239), 7627);
  assert.equal(effectiveRemainingBudgetCents(5000, 8000), -3000);

  const source = readFileSync(resolve(process.cwd(), 'src/services/push-outbox.ts'), 'utf8');
  assert.match(source, /collectWeeklyBudgetDirectExpenses/);
  assert.match(source, /effectiveAvailableBudgetCents/);
  assert.match(source, /availableBudgetCents:\s*effectiveAvailableBudgetCents/);
});

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = path.resolve(here, '../../../modules/banking');
const entry = fs.readFileSync(path.join(moduleRoot, 'entry.js'), 'utf8');
const guard = fs.readFileSync(path.join(moduleRoot, 'popover-guard.js'), 'utf8');

test('banking entry installs a capture-phase popover guard', () => {
  assert.match(entry, /installPopoverGuard/);
  assert.match(guard, /pointerdown/);
  assert.match(guard, /capture:\s*true/);
});

test('popover guard keeps only the active popover and supports Escape dismissal', () => {
  assert.match(guard, /banking-transaction-context-menu/);
  assert.match(guard, /banking-category-picker-menu/);
  assert.match(guard, /banking-transaction-filter-multiselect__menu/);
  assert.match(guard, /banking-account-color-popover/);
  assert.match(guard, /closeAll\(document\.querySelector\(popoverSelector\)\)/);
  assert.match(guard, /event\.key !== 'Escape'/);
  assert.match(guard, /aria-expanded/);
});

test('popover guard dismisses a menu when focus leaves its subtree', () => {
  assert.match(guard, /addEventListener\('focusout'/);
  assert.match(guard, /event\.relatedTarget instanceof Element/);
  assert.match(guard, /popover\.contains\(target\)/);
  assert.match(guard, /!next \|\| !popover\.contains\(next\)/);
});

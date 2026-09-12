import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = path.resolve(here, '../../../modules/banking');
const entry = fs.readFileSync(path.join(moduleRoot, 'entry.js'), 'utf8');
const polish = fs.readFileSync(path.join(moduleRoot, 'layout-polish.js'), 'utf8');
const style = fs.readFileSync(path.join(moduleRoot, 'layout-polish.css'), 'utf8');

test('main banking layout installs the polish layer after the enhanced renderer', () => {
  assert.match(entry, /installMainLayoutPolish/);
  assert.match(entry, /await renderEnhanced\(container, context\)/);
  assert.match(entry, /await installMainLayoutPolish\(container, context\)/);
});

test('weekly budget summary is compact and the accounts panel moves to the bottom', () => {
  assert.match(polish, /\['Budget-Konto', 'Direktausgaben', 'Auffüllbetrag'\]/);
  assert.match(polish, /banking-panel__description/);
  assert.match(polish, /runtime\.main\.append\(accounts\)/);
  assert.match(polish, /yuvomi:banking:accounts-open/);
  assert.match(style, /banking-weekly-budget--compact/);
});

test('transaction table receives budget-week separators derived from the current period', () => {
  assert.match(polish, /weekly-budget\/current/);
  assert.match(polish, /data-budget-week-separator|budgetWeekSeparator/);
  assert.match(polish, /budgetWeekStart/);
  assert.match(polish, /Budgetwoche \$\{formatShortDate\(weekStart\)\}–\$\{formatShortDate\(weekEnd\)\}/);
  assert.match(style, /banking-budget-week-separator__content/);
  assert.match(style, /color-mix/);
});

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = path.resolve(here, '../../../modules/banking');
const entry = fs.readFileSync(path.join(moduleRoot, 'entry.js'), 'utf8');
const enhanced = fs.readFileSync(path.join(moduleRoot, 'enhanced-index.js'), 'utf8');
const style = fs.readFileSync(path.join(moduleRoot, 'visual-enhancements.css'), 'utf8');
const icons = fs.readFileSync(path.join(moduleRoot, 'vendor/phosphor-icons.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'module.json'), 'utf8')) as { entry: string };

test('manifest boots the observer-safe enhancement layer', () => {
  assert.equal(manifest.entry, 'entry.js');
  assert.match(entry, /renderEnhanced/);
  assert.match(entry, /BankingMutationObserver/);
});

test('transaction enhancements remove the dedicated weekly-budget column and provide context actions', () => {
  assert.match(enhanced, /data-transaction-column=\\?"weeklyBudget/);
  assert.match(enhanced, /data\.action = 'transaction-menu'/);
  assert.match(enhanced, /Details anzeigen…/);
  assert.match(enhanced, /Im Wochenbudget berücksichtigen/);
  assert.match(enhanced, /weekly_budget_selected/);
  assert.match(enhanced, /weekly_budget=1|weekly_budget', '1'/);
  assert.match(style, /data-weekly-budget-selected="true"/);
});

test('filters, category visuals and account presentation are available', () => {
  assert.match(enhanced, /Kategorien \(\$\{ids\.length\}\)/);
  assert.match(enhanced, /Nur Wochenbudget/);
  assert.match(enhanced, /data-category-icon-search/);
  assert.match(enhanced, /auto-category-color/);
  assert.match(enhanced, /hexToOklab/);
  assert.match(enhanced, /MIN_AUTO_COLOR_DISTANCE/);
  assert.match(enhanced, /data-account-alias-edit/);
  assert.match(enhanced, /data-account-color-edit/);
  assert.match(style, /banking-account-color-dot/);
  assert.match(style, /banking-category-chip/);
  assert.match(icons, /PHOSPHOR_ICONS/);
  assert.match(icons, /shopping-cart/);
});

test('enhanced dialogs are explicitly centered in the viewport', () => {
  assert.match(style, /\.banking-transaction-dialog,[\s\S]*?\.banking-category-dialog\s*\{[\s\S]*?position:\s*fixed\s*!important;[\s\S]*?inset:\s*0\s*!important;[\s\S]*?margin:\s*auto\s*!important;/);
});

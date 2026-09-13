import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = path.resolve(here, '../../../modules/banking');
const entry = fs.readFileSync(path.join(moduleRoot, 'entry.js'), 'utf8');
const polish = fs.readFileSync(path.join(moduleRoot, 'transaction-semantics-polish.js'), 'utf8');
const style = fs.readFileSync(path.join(moduleRoot, 'transaction-semantics-polish.css'), 'utf8');

test('banking entry captures transaction details and installs semantic presentation', () => {
  assert.match(entry, /installTransactionSemanticsPolish/);
  assert.match(entry, /latestTransactionDetails/);
  assert.match(entry, /transactionDetailMatch/);
  assert.match(entry, /latestTransactionDetails\.set/);
});

test('semantic presentation favors useful bank operation data over processor bank names', () => {
  assert.match(polish, /transaction_display_label/);
  assert.match(polish, /transaction_type === 'card_payment' && method/);
  assert.match(polish, /semantics\.paymentMethod \|\| semantics\.displayLabel/);
  assert.match(polish, /Kartenzahlung/);
  assert.match(polish, /Apple Pay/);
  assert.match(polish, /Bargeldabhebung/);
  assert.match(polish, /Bank-Klassifizierung/);
  assert.match(polish, /transaction_type_description/);
  assert.match(style, /banking-transaction-semantic-summary/);
});

test('semantic presentation removes generic PMNT/payment noise from secondary text', () => {
  assert.match(polish, /cleanSecondaryText/);
  assert.match(polish, /PMNT\|PAYMENT/);
  assert.match(polish, /isGenericSecondaryText/);
  assert.match(polish, /descriptionNormalized\.includes\(displayNormalized\)/);
});

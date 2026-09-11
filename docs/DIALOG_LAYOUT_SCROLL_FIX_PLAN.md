# Banking dialog layout and scrolling fix plan

## Goal

Fix the Banking dialogs so they behave like proper modal dialogs on desktop and mobile, with exactly one vertical scroll container for long content.

The current transaction-detail dialog can show two nested vertical scrollbars at the same time. The outer native `<dialog>` is height-constrained, while `.banking-transaction-dialog__body` is also independently height-constrained and scrollable. This creates the broken layout visible in the current UI: one scrollbar on the dialog itself and another scrollbar inside the body.

The fix should establish a shared modal-shell pattern that can also be used by the category dialog and future Banking dialogs.

Base revision analysed: `7fad97e8a5312a966fc6a36680d2a330e520f7a3`.

## Current implementation and root cause

The transaction dialog markup is currently structured correctly at a high level:

```html
<dialog class="banking-transaction-dialog" data-banking-transaction-dialog>
  <div class="banking-transaction-dialog__header">...</div>
  <div class="banking-transaction-dialog__body" data-banking-transaction-dialog-content></div>
</dialog>
```

However, the CSS gives both levels their own overflow/height responsibility:

```css
.banking-transaction-dialog {
  width: min(54rem, calc(100vw - 2rem));
  max-height: min(90vh, 60rem);
  ...
}

.banking-transaction-dialog__body {
  overflow: auto;
  max-height: calc(90vh - 5rem);
  padding: ...;
}
```

A native `<dialog>` may itself become scrollable when its content exceeds its constrained block size. At the same time the body explicitly has `overflow: auto`. Therefore both the dialog and the body can scroll independently.

There are additional layout problems visible in the screenshot:

- the top-level dialog scrollbar sits directly next to the body scrollbar;
- the close/title header does not own a clearly fixed row in the modal shell;
- long detail content determines layout in two competing height calculations;
- `90vh` is less robust on mobile than dynamic viewport units;
- the two-column detail grid becomes cramped on narrow viewports;
- long IDs, IBANs and provider values can make the dialog unnecessarily wide;
- the provider raw-data area must not introduce another vertical scroll container.

## Target behaviour

The modal must consist of exactly two vertical regions:

```text
+----------------------------------------------------+
| Umsatzdetails                           [Schließen] |  fixed header
+----------------------------------------------------+
|                                                    |
| Amazon                                  -20,80 €   |
| 09.09.26 · Gebucht                                |
|                                                    |
| Buchung                                            |
| ...                                                |
|                                                    |
| Empfänger / Gegenpartei                            |  only this region scrolls
| ...                                                |
|                                                    |
| Eigenes Konto / Bank                               |
| ...                                                |
|                                                    |
| Provider-Rohdaten                                  |
| ...                                                |
+----------------------------------------------------+
```

Required behaviour:

1. The dialog element itself never gets a vertical scrollbar.
2. Only the content/body area scrolls vertically.
3. The title and close button remain visible while the body is scrolled.
4. Short dialogs shrink to their content instead of reserving a large empty height.
5. Long dialogs never exceed the available viewport.
6. Mobile uses almost the full viewport while keeping a small outer margin.
7. Long text wraps instead of forcing the entire dialog horizontally wider.
8. Raw JSON may use its own horizontal scrolling when required, but must not have an independent vertical scrollbar.
9. Native dialog behaviour remains intact: `Escape` closes the dialog and `showModal()` continues to provide top-layer/focus semantics.

## 1. Make the transaction dialog a single flex shell

Primary file:

- `modules/banking/style.css`

Replace the current independent dialog/body max-height model with a flex-column shell.

Recommended shape:

```css
.banking-transaction-dialog {
  box-sizing: border-box;
  width: min(60rem, calc(100vw - 2rem));
  max-width: calc(100vw - 2rem);
  max-height: min(92dvh, 60rem);
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--color-border, #d1d5db);
  border-radius: var(--radius-lg, 16px);
  background: var(--color-surface, #fff);
  color: inherit;
  overscroll-behavior: contain;
}

.banking-transaction-dialog[open] {
  display: flex;
  flex-direction: column;
}
```

Important details:

- `overflow: hidden` on the `<dialog>` is the key part that removes the outer scrollbar.
- The `[open]` selector avoids changing the native hidden state of closed dialogs.
- `dvh` should be preferred over `vh` for mobile browser chrome. A `vh` fallback may be placed before the `dvh` value if desired.
- Keep an explicit upper cap such as `60rem` so very tall desktop displays do not produce an unnecessarily huge dialog.
- Increase width modestly from `54rem` to around `60rem`. The details page contains two-column metadata and currently feels cramped. This width is still bounded by the viewport.

Do not set a fixed `height`. The modal should shrink naturally for short content and only hit `max-height` for long content.

## 2. Give scrolling responsibility exclusively to the dialog body

Replace:

```css
.banking-transaction-dialog__body {
  overflow: auto;
  max-height: calc(90vh - 5rem);
  padding: ...;
}
```

with:

```css
.banking-transaction-dialog__body {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: var(--space-4, 1rem);
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
```

Why `min-height: 0` matters:

Flex items default to an intrinsic minimum size. Without `min-height: 0`, the content area can refuse to shrink below its content height and push the parent dialog back into overflow. This would re-create the outer scrollbar on some browsers.

There must be no second `max-height` formula on the body. The parent dialog owns the maximum size; the body consumes the remaining space after the fixed header.

## 3. Keep the dialog header outside the scroll container

The existing outer markup already places the main header before the body, so no large HTML rewrite is necessary.

Retain:

```html
<div class="banking-transaction-dialog__header">
  <h2>Umsatzdetails</h2>
  <button>Schließen</button>
</div>
<div class="banking-transaction-dialog__body">...</div>
```

CSS should make the outer header a non-shrinking shell row:

```css
.banking-transaction-dialog > .banking-transaction-dialog__header {
  flex: 0 0 auto;
  position: relative;
  z-index: 1;
  background: var(--color-surface, #fff);
}
```

Do not solve this with `position: sticky` inside the scroll area. The header should simply be outside the scrolling element.

## 4. Separate the inner transaction summary from the modal-shell header class

`renderTransactionDetail()` currently inserts another element using `.banking-transaction-dialog__header` inside the body for merchant/date/amount information.

That means the same class currently serves two unrelated purposes:

- modal chrome: `Umsatzdetails` + close button;
- transaction content summary: merchant + date/status + amount.

This coupling makes the layout harder to reason about and can accidentally apply shell-specific rules to the summary inside the scrolling body.

Change the inner summary to a dedicated class, for example:

```html
<div class="banking-transaction-detail-summary">
  <div>
    <strong>Amazon</strong>
    <small>09.09.26 · Gebucht</small>
  </div>
  <strong class="banking-transactions-table__amount">-20,80 €</strong>
</div>
```

Add corresponding CSS:

```css
.banking-transaction-detail-summary {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3, .75rem);
  padding-bottom: var(--space-4, 1rem);
  border-bottom: 1px solid var(--color-border-subtle, rgba(0,0,0,.08));
}

.banking-transaction-detail-summary > div {
  display: grid;
  gap: var(--space-1, .25rem);
  min-width: 0;
}
```

This keeps modal layout rules and content layout rules independent.

Primary file:

- `modules/banking/index.js`

## 5. Improve long-value wrapping

The detail dialog contains values that can be much longer than normal UI text:

- full IBANs;
- provider account IDs;
- counterparty IDs / HMACs;
- entry references;
- transaction IDs;
- remittance text;
- provider-specific codes.

Ensure `dd` values cannot force horizontal overflow:

```css
.banking-transaction-detail-grid dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}
```

Do not globally truncate these values with ellipsis. This is a detail view and the user explicitly needs to see the complete data.

## 6. Make the metadata grid responsive

Desktop can keep the current two-column detail grid:

```css
.banking-transaction-detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
```

At narrow widths switch to one column:

```css
@media (max-width: 42rem) {
  .banking-transaction-detail-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
```

The transaction summary should also adapt on small screens. If merchant/amount cannot fit comfortably on one row, allow wrapping rather than horizontal overflow.

## 7. Mobile viewport behaviour

Add a mobile rule around `42rem` or the existing Banking responsive breakpoint:

```css
@media (max-width: 42rem) {
  .banking-transaction-dialog {
    width: calc(100vw - 1rem);
    max-width: calc(100vw - 1rem);
    max-height: calc(100dvh - 1rem);
    border-radius: var(--radius-md, 12px);
  }

  .banking-transaction-dialog__header,
  .banking-transaction-dialog__body {
    padding: var(--space-3, .75rem);
  }
}
```

The dialog must not become a full-screen page by default, but on small devices a 0.5rem margin around the modal is sufficient.

Use dynamic viewport units so the dialog remains usable when Android/iOS browser chrome changes height.

## 8. Provider raw-data section: no nested vertical scroll

The raw provider payload can be very large. It must remain inside the main body scroll.

Rules:

- do not give `.banking-transaction-detail-raw`, its `<details>`, or its `<pre>` a `max-height` plus `overflow-y: auto`;
- allow `<pre>` to scroll horizontally only when long JSON lines require it;
- keep vertical height natural so the parent body remains the only vertical scroller.

Suggested CSS:

```css
.banking-transaction-detail-raw pre {
  max-width: 100%;
  overflow-x: auto;
  overflow-y: visible;
  white-space: pre;
}
```

If wrapping raw JSON is preferred, `white-space: pre-wrap` plus `overflow-wrap: anywhere` can be used instead, which removes even the horizontal scrollbar. Do not add another vertical scrollbar.

## 9. Apply the same shell principle to the category dialog

The screenshot exposes the transaction dialog, but Banking already has at least one additional native dialog: `.banking-category-dialog`.

The implementation should prevent the same class of bug from appearing there later.

Do not blindly force identical widths. Instead share only the modal-shell mechanics:

- `box-sizing: border-box`;
- viewport-safe `max-height`;
- `overflow: hidden` on the `<dialog>`;
- `[open] { display: flex; flex-direction: column; }` when a header/body shell exists;
- exactly one content element with `overflow-y: auto` and `min-height: 0`;
- fixed/non-scrolling modal header and footer/actions where applicable.

A small shared base class such as `.banking-dialog` is acceptable if changing markup remains simple. Otherwise use grouped selectors. Avoid a large generic component refactor just for this fix.

For category forms, the form/body can be the single scrolling region while the dialog itself remains non-scrollable.

## 10. Optional background-scroll lock

Native `showModal()` creates a top-layer modal and backdrop but does not provide identical page-scroll behaviour in every browser/layout combination.

After the two-scrollbar bug is fixed, verify whether the Banking page behind the dialog can still be scrolled with the mouse wheel/touch gesture while the pointer is outside the modal.

If background scrolling is observable and undesirable, add a narrowly scoped lock while a Banking dialog is open. Prefer CSS if supported by the existing browser baseline; otherwise use a small helper that toggles a class on the document and restores the previous state on `close`.

This is secondary. Do not add JS scroll locking unless it is actually required after the primary dialog overflow fix.

## 11. Focus and close behaviour

Preserve native dialog semantics:

- continue using `dialog.showModal()`;
- keep the existing explicit `Schließen` button;
- `Escape` must close the dialog;
- after closing, focus should return to the control/row that opened the dialog if the browser already does this correctly;
- do not replace `<dialog>` with a custom absolutely positioned `<div>`.

If the current opener loses focus because transaction rows are rerendered while the dialog is open, store the opener only then; otherwise rely on native behaviour.

## 12. Files expected to change

Primary implementation files:

- `modules/banking/style.css`
  - modal shell layout;
  - single-scroll body;
  - responsive detail grid;
  - long-value wrapping;
  - raw-data overflow rules;
  - optional shared dialog mechanics.

- `modules/banking/index.js`
  - rename the inner transaction summary class so it no longer reuses `.banking-transaction-dialog__header`;
  - no API or data-model changes are required.

Tests:

- extend `service/test/transaction-ui-contract.test.ts`;
- optionally add a focused `service/test/dialog-ui-contract.test.ts` if the checks become broader than transaction details.

No database migration is required.

No sidecar API change is required.

## 13. Regression tests

The existing `transaction-ui-contract.test.ts` already checks that the transaction dialog exists and that raw provider JSON is rendered safely. Extend it to protect the layout contract.

Static contract checks should verify at minimum:

- transaction dialog markup still contains one outer header and one body;
- the inner merchant summary uses `banking-transaction-detail-summary` rather than `banking-transaction-dialog__header`;
- the stylesheet contains `overflow: hidden` on `.banking-transaction-dialog`;
- the body has `min-height: 0` and vertical overflow ownership;
- the old `max-height: calc(90vh - 5rem)` body rule is gone;
- the detail grid has a narrow-screen one-column rule;
- raw provider data does not have a separate vertical max-height/scroll rule.

Do not try to prove visual scrollbar count with brittle regex alone. The static tests protect the intended CSS structure; the final acceptance check must also be performed manually in a browser.

## 14. Manual test matrix

### Desktop, long transaction

Viewport approximately 1440x900 or larger.

Expected:

- dialog centered;
- only one vertical scrollbar visible;
- that scrollbar belongs to the content body;
- `Umsatzdetails` and `Schließen` remain visible while scrolling;
- no horizontal scrollbar for normal detail fields;
- merchant/amount summary scrolls away with the content, while the modal title stays fixed.

### Desktop, short transaction

Use a record with little provider data.

Expected:

- dialog shrinks to content height;
- no vertical scrollbar if the content fits;
- no large empty area below the details.

### Raw provider payload expanded

Expand `Alle Provider-Rohdaten`.

Expected:

- body becomes longer and uses the same one vertical scrollbar;
- no second vertical scrollbar appears inside the raw section;
- raw data remains readable/copyable.

### Mobile

Test around 390x844 and 412x915.

Expected:

- small margin around the dialog;
- one-column metadata layout;
- title/close button remain reachable;
- one vertical scrollbar at most;
- no viewport-width overflow;
- full IBANs and IDs wrap.

### Keyboard

Expected:

- opening the dialog moves interaction into the modal;
- close button is reachable by keyboard;
- `Escape` closes it;
- the background cannot be interacted with while modal is open.

## 15. Acceptance criteria

The fix is complete when all of the following are true:

1. The transaction-detail modal never shows two vertical scrollbars.
2. The `<dialog>` itself has `overflow: hidden`; the detail body owns vertical scrolling.
3. The outer `Umsatzdetails / Schließen` header stays visible while scrolling.
4. Short content does not force the modal to a fixed tall size.
5. Long values wrap and remain fully readable.
6. The metadata grid collapses to one column on narrow screens.
7. Provider raw data does not create a nested vertical scrollbar.
8. The category dialog follows the same one-scroll-container principle.
9. Existing `showModal()`, `Escape`, close-button and backdrop behaviour still work.
10. Existing transaction-detail API/data rendering remains unchanged.
11. All existing Banking tests pass.
12. New/extended UI contract tests pass.

## Suggested implementation order

1. Change `.banking-transaction-dialog` to an overflow-hidden flex-column modal shell.
2. Remove the body's independent max-height and make it the sole vertical scroller with `min-height: 0`.
3. Rename the inner transaction content header to `.banking-transaction-detail-summary`.
4. Add long-value wrapping rules.
5. Add responsive one-column/mobile dialog rules.
6. Audit the raw provider `<details>/<pre>` for nested vertical overflow and remove it if present.
7. Apply the same shell mechanics to `.banking-category-dialog` where applicable.
8. Extend transaction/dialog UI contract tests.
9. Run the full service test suite.
10. Manually verify desktop, mobile, long raw JSON and keyboard behaviour.

## Out of scope

This change is a layout/interaction fix only. It should not:

- change transaction data returned by the API;
- change categorization behaviour;
- change transaction-detail field semantics;
- add database migrations;
- replace the native `<dialog>` element;
- redesign the entire Banking page.

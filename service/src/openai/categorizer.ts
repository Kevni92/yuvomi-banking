/**
 * OpenAI-Kategorisierung – Implementierung folgt in Phase 5.
 *
 * Es werden nur ungelöste Umsätze in Batches gesendet.
 * Keine Klartext-IBAN.
 *
 * Erlaubte Eingabefelder:
 * - transaction_id (interne, nicht-bankseitige ID)
 * - counterparty_id (HMAC)
 * - counterparty_name
 * - merchant_name
 * - purpose
 * - amount
 * - currency
 * - direction
 * - mcc (falls vorhanden)
 *
 * Ausgabe:
 * - category_id aus bestehender Allowlist
 * - confidence
 * - reason (kurz)
 * - optional suggested_category
 *
 * Neue Kategorien werden nur vorgeschlagen und müssen vom Nutzer bestätigt werden.
 */
export {};

import type { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { createEncryptionService } from '../security/encryption.js';
import { counterpartyId } from './counterparty.js';
import { addCalendarDays, localDateForInstant } from './weekly-budget-schedule.js';

const MATCH_WINDOW_DAYS = 14;

interface SuggestionRow {
  id: number;
  source_account_id: number;
  target_account_id: number;
  computed_amount_cents: number;
  purpose: string | null;
  generated_at: string | null;
  week_end: string;
  timezone: string | null;
  source_iban_encrypted: string | null;
  target_iban_encrypted: string | null;
  matched_source_transaction_id: number | null;
  matched_target_transaction_id: number | null;
}

export interface WeeklyBudgetTransferMatchOutcome {
  suggestionId: number;
  source: 'unchanged' | 'matched' | 'ambiguous' | 'not_found';
  target: 'unchanged' | 'matched' | 'ambiguous' | 'not_found';
  state: 'proposed' | 'source_booked' | 'target_booked' | 'target_arrived';
}

export function matchWeeklyBudgetTransfers(
  database: DatabaseSync,
  configId: number,
  now = new Date()
): WeeklyBudgetTransferMatchOutcome[] {
  if (!Number.isSafeInteger(configId) || configId < 1) {
    throw new Error('Weekly-budget configuration ID is invalid.');
  }
  if (Number.isNaN(now.getTime())) throw new Error('Transfer-matching time is invalid.');

  const rows = database.prepare(`
    SELECT transfer_suggestions.id, transfer_suggestions.source_account_id,
           transfer_suggestions.target_account_id,
           transfer_suggestions.computed_amount_cents,
           transfer_suggestions.purpose, transfer_suggestions.generated_at,
           transfer_suggestions.week_end,
           transfer_suggestions.matched_source_transaction_id,
           transfer_suggestions.matched_target_transaction_id,
           weekly_budget_periods.timezone,
           source_account.iban_encrypted AS source_iban_encrypted,
           target_account.iban_encrypted AS target_iban_encrypted
    FROM transfer_suggestions
    JOIN weekly_budget_periods
      ON weekly_budget_periods.id = transfer_suggestions.period_id
    JOIN bank_accounts AS source_account
      ON source_account.id = transfer_suggestions.source_account_id
    JOIN bank_accounts AS target_account
      ON target_account.id = transfer_suggestions.target_account_id
    WHERE weekly_budget_periods.config_id = ?
      AND transfer_suggestions.computed_amount_cents > 0
      AND transfer_suggestions.status NOT IN ('dismissed', 'superseded', 'failed', 'no_transfer')
      AND (
        transfer_suggestions.matched_source_transaction_id IS NULL
        OR transfer_suggestions.matched_target_transaction_id IS NULL
      )
    ORDER BY transfer_suggestions.generated_at, transfer_suggestions.id
  `).all(configId) as unknown as SuggestionRow[];

  const encryption = createEncryptionService();
  const outcomes: WeeklyBudgetTransferMatchOutcome[] = [];
  for (const row of rows) {
    const marker = transferPurposeMarker(row.purpose);
    const windowStart = matchingWindowStart(row);
    const windowEnd = addCalendarDays(windowStart, MATCH_WINDOW_DAYS);
    const sourceCounterparty = encryptedCounterpartyId(
      encryption,
      row.target_iban_encrypted
    );
    const targetCounterparty = encryptedCounterpartyId(
      encryption,
      row.source_iban_encrypted
    );

    const sourceMatch = row.matched_source_transaction_id
      ? { state: 'unchanged' as const, id: row.matched_source_transaction_id }
      : findUniqueCandidate(database, {
          suggestionId: row.id,
          accountId: row.source_account_id,
          amountCents: row.computed_amount_cents,
          direction: 'outgoing',
          counterpartyId: sourceCounterparty,
          marker,
          windowStart,
          windowEnd,
          matchedColumn: 'matched_source_transaction_id'
        });
    const targetMatch = row.matched_target_transaction_id
      ? { state: 'unchanged' as const, id: row.matched_target_transaction_id }
      : findUniqueCandidate(database, {
          suggestionId: row.id,
          accountId: row.target_account_id,
          amountCents: row.computed_amount_cents,
          direction: 'incoming',
          counterpartyId: targetCounterparty,
          marker,
          windowStart,
          windowEnd,
          matchedColumn: 'matched_target_transaction_id'
        });

    const sourceId = sourceMatch.id ?? row.matched_source_transaction_id;
    const targetId = targetMatch.id ?? row.matched_target_transaction_id;
    if (sourceMatch.state === 'matched' || targetMatch.state === 'matched') {
      const completed = Boolean(sourceId && targetId);
      database.prepare(`
        UPDATE transfer_suggestions SET
          matched_source_transaction_id = COALESCE(matched_source_transaction_id, ?),
          matched_target_transaction_id = COALESCE(matched_target_transaction_id, ?),
          status = CASE WHEN ? THEN 'completed' ELSE status END,
          completed_at = CASE WHEN ? THEN COALESCE(completed_at, ?) ELSE completed_at END,
          updated_at = ?
        WHERE id = ?
      `).run(
        sourceId,
        targetId,
        completed ? 1 : 0,
        completed ? 1 : 0,
        now.toISOString(),
        now.toISOString(),
        row.id
      );
    }
    outcomes.push({
      suggestionId: Number(row.id),
      source: sourceMatch.state,
      target: targetMatch.state,
      state: transferState(sourceId, targetId)
    });
  }
  return outcomes;
}

function findUniqueCandidate(
  database: DatabaseSync,
  input: {
    suggestionId: number;
    accountId: number;
    amountCents: number;
    direction: 'incoming' | 'outgoing';
    counterpartyId: string | null;
    marker: string | null;
    windowStart: string;
    windowEnd: string;
    matchedColumn: 'matched_source_transaction_id' | 'matched_target_transaction_id';
  }
): { state: 'matched' | 'ambiguous' | 'not_found'; id: number | null } {
  if (!input.counterpartyId || !input.marker) return { state: 'not_found', id: null };
  const rows = database.prepare(`
    SELECT transactions.id, transactions.purpose
    FROM transactions
    JOIN counterparties ON counterparties.id = transactions.counterparty_ref
    WHERE transactions.account_id = ?
      AND transactions.status = 'BOOK'
      AND transactions.currency = 'EUR'
      AND transactions.direction = ?
      AND transactions.amount_cents = ?
      AND counterparties.counterparty_id = ?
      AND COALESCE(
        transactions.booking_date,
        transactions.value_date,
        transactions.transaction_date
      ) >= ?
      AND COALESCE(
        transactions.booking_date,
        transactions.value_date,
        transactions.transaction_date
      ) < ?
      AND NOT EXISTS (
        SELECT 1 FROM transfer_suggestions AS used
        WHERE used.${input.matchedColumn} = transactions.id
          AND used.id <> ?
      )
    ORDER BY transactions.id
  `).all(
    input.accountId,
    input.direction,
    input.amountCents,
    input.counterpartyId,
    input.windowStart,
    input.windowEnd,
    input.suggestionId
  ) as Array<Record<string, unknown>>;
  const marker = normalizeMatchText(input.marker);
  const matching = rows.filter((row) =>
    normalizeMatchText(typeof row.purpose === 'string' ? row.purpose : '').includes(marker)
  );
  if (matching.length === 1) return { state: 'matched', id: Number(matching[0].id) };
  return { state: matching.length > 1 ? 'ambiguous' : 'not_found', id: null };
}

function transferPurposeMarker(purpose: string | null): string | null {
  if (!purpose) return null;
  const match = /^(.{1,32}?\s\d{4}-\d{2}-\d{2}):/.exec(purpose.trim());
  return match?.[1] ?? null;
}

function matchingWindowStart(row: SuggestionRow): string {
  if (row.generated_at && row.timezone) {
    const generatedAt = new Date(row.generated_at);
    if (!Number.isNaN(generatedAt.getTime())) {
      try {
        return localDateForInstant(generatedAt, row.timezone);
      } catch {
        // Fall back to the snapshotted period end.
      }
    }
  }
  return row.week_end;
}

function encryptedCounterpartyId(
  encryption: ReturnType<typeof createEncryptionService>,
  encryptedIban: string | null
): string | null {
  if (!encryptedIban) return null;
  try {
    return counterpartyId(
      encryption.decrypt(encryptedIban),
      config.secrets.counterpartyHmac
    );
  } catch {
    return null;
  }
}

function normalizeMatchText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function transferState(
  sourceTransactionId: number | null,
  targetTransactionId: number | null
): WeeklyBudgetTransferMatchOutcome['state'] {
  if (sourceTransactionId && targetTransactionId) return 'target_arrived';
  if (sourceTransactionId) return 'source_booked';
  if (targetTransactionId) return 'target_booked';
  return 'proposed';
}

export type WeeklyBudgetOverride = 'inherit' | 'include' | 'exclude';
export type WeeklyBudgetDecisionSource =
  | 'transaction_override'
  | 'category_default'
  | 'none';

export interface WeeklyBudgetDecision {
  included: boolean;
  source: WeeklyBudgetDecisionSource;
}

export function resolveWeeklyBudgetDecision(
  transactionOverride: WeeklyBudgetOverride,
  categoryDefault: boolean | null | undefined
): WeeklyBudgetDecision {
  if (transactionOverride === 'include') {
    return { included: true, source: 'transaction_override' };
  }
  if (transactionOverride === 'exclude') {
    return { included: false, source: 'transaction_override' };
  }
  if (transactionOverride !== 'inherit') {
    throw new Error('Unknown weekly-budget transaction override.');
  }
  if (categoryDefault === true) {
    return { included: true, source: 'category_default' };
  }
  return { included: false, source: 'none' };
}

export type DirectExpenseExclusionReason =
  | 'wrong_account'
  | 'not_outgoing'
  | 'not_booked'
  | 'not_eur'
  | 'internal_transfer'
  | 'refill_transfer'
  | 'not_weekly_budget'
  | 'missing_date'
  | 'outside_period';

export interface DirectExpenseCandidate {
  accountId: number;
  sourceAccountId: number;
  direction: 'incoming' | 'outgoing';
  status: 'PDNG' | 'BOOK' | 'UNKNOWN';
  currency: string;
  amountCents: number;
  bookingDate?: string | null;
  valueDate?: string | null;
  transactionDate?: string | null;
  transactionOverride: WeeklyBudgetOverride;
  categoryDefault?: boolean | null;
  isInternalTransfer?: boolean;
  isRefillTransfer?: boolean;
  periodStartDate: string;
  periodEndDate: string;
}

export interface DirectExpenseEvaluation {
  included: boolean;
  amountCents: number;
  effectiveDate: string | null;
  decision: WeeklyBudgetDecision;
  exclusionReason: DirectExpenseExclusionReason | null;
}

export function evaluateDirectExpense(
  candidate: DirectExpenseCandidate
): DirectExpenseEvaluation {
  assertPositiveId(candidate.accountId, 'Transaction account ID');
  assertPositiveId(candidate.sourceAccountId, 'Source account ID');
  assertSafeInteger(candidate.amountCents, 'Transaction amount');
  assertIsoDate(candidate.periodStartDate, 'Period start date');
  assertIsoDate(candidate.periodEndDate, 'Period end date');
  if (candidate.periodStartDate >= candidate.periodEndDate) {
    throw new Error('Weekly-budget period must end after it starts.');
  }

  const decision = resolveWeeklyBudgetDecision(
    candidate.transactionOverride,
    candidate.categoryDefault
  );
  const effectiveDate = selectEffectiveTransactionDate(candidate);
  let exclusionReason: DirectExpenseExclusionReason | null = null;

  if (candidate.accountId !== candidate.sourceAccountId) exclusionReason = 'wrong_account';
  else if (candidate.direction !== 'outgoing') exclusionReason = 'not_outgoing';
  else if (candidate.status !== 'BOOK') exclusionReason = 'not_booked';
  else if (candidate.currency.toUpperCase() !== 'EUR') exclusionReason = 'not_eur';
  else if (candidate.isInternalTransfer) exclusionReason = 'internal_transfer';
  else if (candidate.isRefillTransfer) exclusionReason = 'refill_transfer';
  else if (!decision.included) exclusionReason = 'not_weekly_budget';
  else if (!effectiveDate) exclusionReason = 'missing_date';
  else if (
    effectiveDate < candidate.periodStartDate
    || effectiveDate >= candidate.periodEndDate
  ) exclusionReason = 'outside_period';

  return {
    included: exclusionReason === null,
    amountCents: Math.abs(candidate.amountCents),
    effectiveDate,
    decision,
    exclusionReason
  };
}

export function selectEffectiveTransactionDate(value: {
  bookingDate?: string | null;
  valueDate?: string | null;
  transactionDate?: string | null;
}): string | null {
  for (const candidate of [value.bookingDate, value.valueDate, value.transactionDate]) {
    if (candidate == null || candidate === '') continue;
    assertIsoDate(candidate, 'Transaction date');
    return candidate;
  }
  return null;
}

export interface WeeklyBudgetCalculationInput {
  targetAmountCents: number;
  directExpenseCents: number;
  targetBalanceCents: number;
}

export interface WeeklyBudgetCalculation {
  targetAmountCents: number;
  directExpenseCents: number;
  targetBalanceCents: number;
  rawComputedAmountCents: number;
  transferAmountCents: number;
  overfundedCents: number;
  calculationVersion: 'weekly-budget-v1';
}

export function calculateWeeklyBudgetTransfer(
  input: WeeklyBudgetCalculationInput
): WeeklyBudgetCalculation {
  assertPositiveCents(input.targetAmountCents, 'Weekly target');
  assertNonNegativeCents(input.directExpenseCents, 'Direct expenses');
  assertSafeInteger(input.targetBalanceCents, 'Target-account balance');

  const rawBigInt = BigInt(input.targetAmountCents)
    - BigInt(input.directExpenseCents)
    - BigInt(input.targetBalanceCents);
  const rawComputedAmountCents = safeBigIntToNumber(rawBigInt, 'Calculated transfer');

  return {
    ...input,
    rawComputedAmountCents,
    transferAmountCents: Math.max(0, rawComputedAmountCents),
    overfundedCents: Math.max(0, -rawComputedAmountCents),
    calculationVersion: 'weekly-budget-v1'
  };
}

export interface TransferPurposeInput extends WeeklyBudgetCalculationInput {
  cutoffDate: string;
  transferAmountCents: number;
  prefix?: string;
  targetAccountLabel?: string;
}

export function buildWeeklyBudgetTransferPurpose(input: TransferPurposeInput): string {
  assertIsoDate(input.cutoffDate, 'Cutoff date');
  assertPositiveCents(input.targetAmountCents, 'Weekly target');
  assertNonNegativeCents(input.directExpenseCents, 'Direct expenses');
  assertSafeInteger(input.targetBalanceCents, 'Target-account balance');
  assertNonNegativeCents(input.transferAmountCents, 'Transfer amount');
  const calculation = calculateWeeklyBudgetTransfer(input);
  if (input.transferAmountCents !== calculation.transferAmountCents) {
    throw new Error('Transfer amount does not match the weekly-budget factors.');
  }

  const prefix = (input.prefix ?? 'WB').trim();
  if (!/^[A-Za-z0-9]{1,10}$/.test(prefix)) {
    throw new Error('Transfer-purpose prefix must contain 1 to 10 ASCII letters or digits.');
  }
  const targetLabel = (input.targetAccountLabel ?? 'N26').trim();
  if (!/^[A-Za-z0-9 ._-]{1,20}$/.test(targetLabel)) {
    throw new Error('Target-account label contains unsupported characters.');
  }

  const target = formatEuroCents(input.targetAmountCents);
  const direct = formatEuroCents(input.directExpenseCents);
  const balance = formatEuroCents(input.targetBalanceCents);
  const transfer = formatEuroCents(input.transferAmountCents);
  const balanceFactor = input.targetBalanceCents < 0
    ? `- (${balance} ${targetLabel})`
    : `- ${balance} ${targetLabel}`;
  const canonical = `${prefix} ${input.cutoffDate}: ${target} - ${direct} Direkt ${balanceFactor} = ${transfer} EUR`;
  if (canonical.length <= 140) return canonical;

  const compactBalanceFactor = input.targetBalanceCents < 0
    ? `-(${balance}N)`
    : `-${balance}N`;
  const compact = `${prefix} ${input.cutoffDate}:${target}-${direct}D${compactBalanceFactor}=${transfer}EUR`;
  if (compact.length > 140) {
    throw new Error('Transfer purpose exceeds the 140-character limit.');
  }
  return compact;
}

export function formatEuroCents(cents: number): string {
  assertSafeInteger(cents, 'Euro amount');
  const absolute = cents < 0 ? -BigInt(cents) : BigInt(cents);
  const euros = absolute / 100n;
  const remainder = (absolute % 100n).toString().padStart(2, '0');
  return `${cents < 0 ? '-' : ''}${euros},${remainder}`;
}

function assertPositiveId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} is invalid.`);
  }
}

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer number of cents.`);
  }
}

function assertPositiveCents(value: number, label: string): void {
  assertSafeInteger(value, label);
  if (value <= 0) throw new Error(`${label} must be positive.`);
}

function assertNonNegativeCents(value: number, label: string): void {
  assertSafeInteger(value, label);
  if (value < 0) throw new Error(`${label} must not be negative.`);
}

function safeBigIntToNumber(value: bigint, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new Error(`${label} exceeds the supported range.`);
  }
  return result;
}

function assertIsoDate(value: string, label: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`${label} must use YYYY-MM-DD.`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new Error(`${label} is not a valid calendar date.`);
  }
}

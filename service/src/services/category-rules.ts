import type { DatabaseSync } from 'node:sqlite';

type RuleType = 'counterparty' | 'merchant' | 'text';
type RuleSource = 'manual' | 'learned' | 'system';

interface RuleRow {
  id: number;
  rule_type: RuleType;
  match_value: string;
  category_id: number;
  source: RuleSource;
  priority: number;
}

interface TransactionRow {
  id: number;
  counterparty_id: string | null;
  counterparty_name: string | null;
  merchant_name: string | null;
  purpose: string | null;
}

export interface ManualCategoryAssignmentResult {
  transactionId: number;
  categoryId: number;
  ruleCreated: boolean;
  affectedTransactions: number;
}

export class CategoryAssignmentNotFoundError extends Error {}
export class CategoryAssignmentValidationError extends Error {}

/**
 * Applies only rules owned by the account owner (plus future system rules).
 * A per-transaction manual assignment is intentionally never overwritten.
 */
export function applyCategoryRulesForAccount(
  database: DatabaseSync,
  accountId: number,
  now = new Date()
): number {
  if (!Number.isSafeInteger(accountId) || accountId < 1) {
    throw new CategoryAssignmentValidationError('Bank account ID is invalid.');
  }
  const owner = database.prepare(`
    SELECT enable_banking_connections.yuvomi_user_id
    FROM bank_accounts
    JOIN enable_banking_connections
      ON enable_banking_connections.id = bank_accounts.connection_id
    WHERE bank_accounts.id = ?
    LIMIT 1
  `).get(accountId) as { yuvomi_user_id: number } | undefined;
  if (!owner) throw new CategoryAssignmentNotFoundError('Bank account was not found.');

  return applyRules(database, Number(owner.yuvomi_user_id), accountId, now);
}

export function assignManualTransactionCategory(
  database: DatabaseSync,
  input: {
    yuvomiUserId: number;
    transactionId: number;
    categoryId: number;
    rememberCounterparty?: boolean;
    now?: Date;
  }
): ManualCategoryAssignmentResult {
  const now = input.now ?? new Date();
  if (
    !Number.isSafeInteger(input.yuvomiUserId) || input.yuvomiUserId < 1
    || !Number.isSafeInteger(input.transactionId) || input.transactionId < 1
    || !Number.isSafeInteger(input.categoryId) || input.categoryId < 1
    || Number.isNaN(now.getTime())
  ) {
    throw new CategoryAssignmentValidationError('Category assignment is invalid.');
  }
  const category = database.prepare(`
    SELECT id FROM categories WHERE id = ? AND active = 1 LIMIT 1
  `).get(input.categoryId) as { id: number } | undefined;
  if (!category) throw new CategoryAssignmentNotFoundError('Category was not found.');

  let transactionOpen = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    transactionOpen = true;
    const transaction = database.prepare(`
      SELECT transactions.id, transactions.account_id,
             counterparties.counterparty_id
      FROM transactions
      JOIN bank_accounts ON bank_accounts.id = transactions.account_id
      JOIN enable_banking_connections
        ON enable_banking_connections.id = bank_accounts.connection_id
      LEFT JOIN counterparties ON counterparties.id = transactions.counterparty_ref
      WHERE transactions.id = ?
        AND enable_banking_connections.yuvomi_user_id = ?
      LIMIT 1
    `).get(input.transactionId, input.yuvomiUserId) as {
      id: number;
      account_id: number;
      counterparty_id: string | null;
    } | undefined;
    if (!transaction) {
      throw new CategoryAssignmentNotFoundError('Transaction was not found.');
    }

    const timestamp = now.toISOString();
    database.prepare(`
      UPDATE transactions SET
        category_id = ?, category_source = 'manual', category_confidence = 1,
        updated_at = ?
      WHERE id = ?
    `).run(input.categoryId, timestamp, input.transactionId);
    database.prepare(`
      UPDATE ai_categorization_reviews SET
        status = 'applied', updated_at = ?, resolved_at = ?
      WHERE transaction_id = ? AND status = 'pending'
    `).run(timestamp, timestamp, input.transactionId);

    let ruleCreated = false;
    let affectedTransactions = 1;
    if (input.rememberCounterparty !== false && transaction.counterparty_id) {
      database.prepare(`
        DELETE FROM category_rules
        WHERE yuvomi_user_id = ?
          AND rule_type = 'counterparty'
          AND match_value = ?
          AND source = 'manual'
      `).run(input.yuvomiUserId, transaction.counterparty_id);
      database.prepare(`
        INSERT INTO category_rules (
          yuvomi_user_id, rule_type, match_value, category_id,
          priority, source, enabled, created_at, updated_at
        ) VALUES (?, 'counterparty', ?, ?, 0, 'manual', 1, ?, ?)
      `).run(
        input.yuvomiUserId,
        transaction.counterparty_id,
        input.categoryId,
        timestamp,
        timestamp
      );
      ruleCreated = true;
      const result = database.prepare(`
        UPDATE transactions SET
          category_id = ?, category_source = 'counterparty_rule',
          category_confidence = 1, updated_at = ?
        WHERE id != ?
          AND category_source IS NOT 'manual'
          AND counterparty_ref IN (
            SELECT id FROM counterparties WHERE counterparty_id = ?
          )
          AND account_id IN (
            SELECT bank_accounts.id
            FROM bank_accounts
            JOIN enable_banking_connections
              ON enable_banking_connections.id = bank_accounts.connection_id
            WHERE enable_banking_connections.yuvomi_user_id = ?
          )
      `).run(
        input.categoryId,
        timestamp,
        input.transactionId,
        transaction.counterparty_id,
        input.yuvomiUserId
      );
      affectedTransactions += Number(result.changes);
    }
    database.exec('COMMIT;');
    transactionOpen = false;
    return {
      transactionId: input.transactionId,
      categoryId: input.categoryId,
      ruleCreated,
      affectedTransactions
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        database.exec('ROLLBACK;');
      } catch {
        // Preserve the original failure.
      }
    }
    throw error;
  }
}

export function normalizeCategoryRuleText(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function applyRules(
  database: DatabaseSync,
  yuvomiUserId: number,
  accountId: number,
  now: Date
): number {
  const rules = database.prepare(`
    SELECT category_rules.id, category_rules.rule_type,
           category_rules.match_value, category_rules.category_id,
           category_rules.source, category_rules.priority
    FROM category_rules
    JOIN categories ON categories.id = category_rules.category_id
    WHERE category_rules.enabled = 1
      AND categories.active = 1
      AND (category_rules.yuvomi_user_id = ? OR category_rules.yuvomi_user_id IS NULL)
  `).all(yuvomiUserId) as unknown as RuleRow[];
  if (rules.length === 0) return 0;
  rules.sort(compareRules);

  const transactions = database.prepare(`
    SELECT transactions.id, counterparties.counterparty_id,
           transactions.counterparty_name, transactions.merchant_name,
           transactions.purpose
    FROM transactions
    LEFT JOIN counterparties ON counterparties.id = transactions.counterparty_ref
    WHERE transactions.account_id = ?
      AND COALESCE(transactions.category_source, '') != 'manual'
  `).all(accountId) as unknown as TransactionRow[];
  const update = database.prepare(`
    UPDATE transactions SET category_id = ?, category_source = ?,
      category_confidence = 1, updated_at = ?
    WHERE id = ? AND COALESCE(category_source, '') != 'manual'
  `);
  const timestamp = now.toISOString();
  let applied = 0;
  for (const transaction of transactions) {
    const rule = rules.find((candidate) => ruleMatches(candidate, transaction));
    if (!rule) continue;
    const source = rule.rule_type === 'counterparty'
      ? 'counterparty_rule'
      : rule.rule_type === 'merchant'
        ? 'merchant_rule'
        : 'text_rule';
    const result = update.run(rule.category_id, source, timestamp, transaction.id);
    applied += Number(result.changes);
  }
  return applied;
}

function compareRules(left: RuleRow, right: RuleRow): number {
  return ruleRank(left) - ruleRank(right)
    || left.priority - right.priority
    || left.id - right.id;
}

function ruleRank(rule: RuleRow): number {
  if (rule.rule_type === 'counterparty' && rule.source === 'manual') return 0;
  if (rule.rule_type === 'counterparty') return 1;
  if (rule.rule_type === 'merchant') return 2;
  return 3;
}

function ruleMatches(rule: RuleRow, transaction: TransactionRow): boolean {
  if (rule.rule_type === 'counterparty') {
    return transaction.counterparty_id === rule.match_value;
  }
  if (rule.rule_type === 'merchant') {
    const merchant = transaction.merchant_name ?? transaction.counterparty_name;
    return merchant !== null && normalizeCategoryRuleText(merchant) === rule.match_value;
  }
  const purpose = transaction.purpose;
  return purpose !== null && normalizeCategoryRuleText(purpose).includes(rule.match_value);
}

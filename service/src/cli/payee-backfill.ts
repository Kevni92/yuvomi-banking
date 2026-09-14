import type { DatabaseSync } from 'node:sqlite';
import type { EncryptionService } from '../security/encryption.js';
import { applyPayeeCategoriesForAccount, resolvePayeesForAccount } from '../services/recurring-payees.js';

export interface PayeeBackfillResult {
  considered: number;
  matched: number;
  created: number;
  confirmed: number;
  candidates: number;
  ambiguous: number;
  excluded: number;
  legacy_rules_adopted: number;
  legacy_category_conflicts: number;
}

/**
 * Runs the historical resolver account by account when applying. Dry-run is
 * implemented by rolling one measurement transaction back, so the same
 * matching decisions are measured without leaving partial state behind.
 */
export function backfillPayees({
  database,
  encryption,
  hmacSecret,
  now = new Date(),
  apply = false
}: {
  database: DatabaseSync;
  encryption: EncryptionService;
  hmacSecret: string;
  now?: Date;
  apply?: boolean;
}): PayeeBackfillResult {
  const result: PayeeBackfillResult = {
    considered: 0, matched: 0, created: 0, confirmed: 0, candidates: 0,
    ambiguous: 0, excluded: 0, legacy_rules_adopted: 0, legacy_category_conflicts: 0
  };
  const accounts = database.prepare('SELECT id FROM bank_accounts ORDER BY id').all() as Array<{ id: number }>;
  if (!apply) {
    database.exec('BEGIN IMMEDIATE;');
    try {
      for (const account of accounts) add(result, resolveAccount({
        database, accountId: Number(account.id), encryption, hmacSecret, now
      }));
      const legacy = adoptLegacyRules(database, now);
      result.legacy_rules_adopted = legacy.adopted;
      result.legacy_category_conflicts = legacy.conflicts;
      for (const account of accounts) applyPayeeCategoriesForAccount(database, Number(account.id), now);
      database.exec('ROLLBACK;');
      return result;
    } catch (error) {
      try { database.exec('ROLLBACK;'); } catch { /* preserve original error */ }
      throw error;
    }
  }

  // Apply account by account. A later invocation can safely continue after an
  // interruption because all resolver writes are idempotent.
  for (const account of accounts) {
    database.exec('BEGIN IMMEDIATE;');
    try {
      add(result, resolveAccount({
        database, accountId: Number(account.id), encryption, hmacSecret, now
      }));
      applyPayeeCategoriesForAccount(database, Number(account.id), now);
      database.exec('COMMIT;');
    } catch (error) {
      try { database.exec('ROLLBACK;'); } catch { /* preserve original error */ }
      throw error;
    }
  }

  database.exec('BEGIN IMMEDIATE;');
  try {
    const legacy = adoptLegacyRules(database, now);
    result.legacy_rules_adopted = legacy.adopted;
    result.legacy_category_conflicts = legacy.conflicts;
    for (const account of accounts) applyPayeeCategoriesForAccount(database, Number(account.id), now);
    database.exec('COMMIT;');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK;'); } catch { /* preserve original error */ }
    throw error;
  }
}

function resolveAccount({
  database, accountId, encryption, hmacSecret, now
}: {
  database: DatabaseSync;
  accountId: number;
  encryption: EncryptionService;
  hmacSecret: string;
  now: Date;
}): ReturnType<typeof resolvePayeesForAccount> {
  return resolvePayeesForAccount({
    database, accountId, encryption, hmacSecret, now, manageTransaction: false
  });
}

function adoptLegacyRules(database: DatabaseSync, now: Date): { adopted: number; conflicts: number } {
  const rules = database.prepare(`
    SELECT category_rules.yuvomi_user_id, category_rules.match_value, category_rules.category_id
      FROM category_rules
     WHERE category_rules.rule_type = 'counterparty'
       AND category_rules.source = 'manual'
       AND category_rules.enabled = 1
  `).all() as Array<{ yuvomi_user_id: number; match_value: string; category_id: number }>;
  const findPayees = database.prepare(`
    SELECT payee_id, category_id FROM payee_identifiers
     JOIN payees ON payees.id = payee_identifiers.payee_id
    WHERE payee_identifiers.yuvomi_user_id = ?
      AND payee_identifiers.identifier_type = 'counterparty_iban'
      AND payee_identifiers.identifier_hash = ?
  `);
  const updatePayee = database.prepare(`
    UPDATE payees SET category_id = ?, status = 'confirmed', confirmed_at = COALESCE(confirmed_at, ?), updated_at = ?
     WHERE id = ? AND yuvomi_user_id = ? AND category_id IS NULL
  `);
  let adopted = 0;
  let conflicts = 0;
  for (const rule of rules) {
    const payees = findPayees.all(rule.yuvomi_user_id, rule.match_value) as Array<{ payee_id: number; category_id: number | null }>;
    const ids = [...new Set(payees.map((row) => Number(row.payee_id)))];
    if (ids.length !== 1) {
      if (ids.length > 1) conflicts += 1;
      continue;
    }
    const category = database.prepare(`SELECT id FROM categories WHERE id = ? AND active = 1 AND type = 'expense'`).get(rule.category_id);
    if (!category) continue;
    const changed = updatePayee.run(rule.category_id, now.toISOString(), now.toISOString(), ids[0], rule.yuvomi_user_id);
    adopted += Number(changed.changes);
  }
  return { adopted, conflicts };
}

function add(target: PayeeBackfillResult, source: Omit<PayeeBackfillResult, 'legacy_rules_adopted' | 'legacy_category_conflicts'>): void {
  target.considered += source.considered;
  target.matched += source.matched;
  target.created += source.created;
  target.confirmed += source.confirmed;
  target.candidates += source.candidates;
  target.ambiguous += source.ambiguous;
  target.excluded += source.excluded;
}

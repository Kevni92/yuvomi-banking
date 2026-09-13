import type { DatabaseSync } from 'node:sqlite';
import type { YuvomiUser } from './yuvomi-session.js';

export type BankingSessionResolver = (cookieHeader?: string) => Promise<YuvomiUser | null>;

/**
 * Banking is a shared household module. Yuvomi still authenticates the actor
 * and supplies that actor's module permission, but all banking domain data is
 * read/written through the owner of the already existing Banking setup.
 *
 * This keeps Kevin's existing connections, accounts, transactions, learned
 * category rules and weekly-budget configuration visible to every Yuvomi user
 * who has access to ext:banking, without duplicating or migrating the data.
 */
export function createGlobalBankingSessionResolver(
  database: DatabaseSync,
  resolveSession: BankingSessionResolver
): BankingSessionResolver {
  return async (cookieHeader?: string) => {
    const actor = await resolveSession(cookieHeader);
    if (!actor) return null;

    const ownerId = resolveGlobalBankingOwnerId(database, actor.id);
    if (ownerId === actor.id) return actor;

    // Keep the actor's display name, role and permissions. Only the database
    // ownership id is mapped to the shared Banking setup.
    return { ...actor, id: ownerId };
  };
}

/**
 * Resolve the single existing Banking owner. Connections are the strongest
 * signal because accounts and transactions hang from them. The remaining
 * tables cover installations where Banking was configured before a bank
 * connection was completed.
 */
export function resolveGlobalBankingOwnerId(
  database: DatabaseSync,
  fallbackUserId: number
): number {
  const lookups = [
    `SELECT yuvomi_user_id
       FROM enable_banking_connections
      WHERE yuvomi_user_id IS NOT NULL
      ORDER BY id
      LIMIT 1`,
    `SELECT yuvomi_user_id
       FROM weekly_budget_configs
      WHERE yuvomi_user_id IS NOT NULL
      ORDER BY id
      LIMIT 1`,
    `SELECT yuvomi_user_id
       FROM category_rules
      WHERE yuvomi_user_id IS NOT NULL
      ORDER BY id
      LIMIT 1`,
    `SELECT yuvomi_user_id
       FROM category_suggestions
      WHERE yuvomi_user_id IS NOT NULL
      ORDER BY id
      LIMIT 1`
  ];

  for (const sql of lookups) {
    try {
      const row = database.prepare(sql).get() as { yuvomi_user_id?: unknown } | undefined;
      const id = Number(row?.yuvomi_user_id);
      if (Number.isSafeInteger(id) && id > 0) return id;
    } catch {
      // Keep startup/migration compatibility if an older schema does not yet
      // contain one of the fallback tables or columns.
    }
  }

  return fallbackUserId;
}

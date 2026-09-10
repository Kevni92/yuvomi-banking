import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const MIGRATION_DIRECTORY_CANDIDATES = [
  fileURLToPath(new URL('../../migrations/', import.meta.url)),
  fileURLToPath(new URL('../../../migrations/', import.meta.url))
];
const DEFAULT_MIGRATIONS_DIRECTORY = MIGRATION_DIRECTORY_CANDIDATES.find(
  (directory) => fs.existsSync(directory)
) ?? MIGRATION_DIRECTORY_CANDIDATES[0];

export interface MigrationFile {
  version: number;
  filename: string;
  filePath: string;
}

/**
 * Platzhalter für die DB-Schicht.
 *
 * In Phase 2 wird hier die konkrete SQLite-Anbindung implementiert.
 * Die Migrationen liegen bereits unter service/migrations/.
 *
 * WICHTIG:
 * - nur banking.db öffnen
 * - niemals yuvomi.db öffnen
 * - Migrationen append-only
 */
function assertBankingDatabasePath(databasePath: string): string {
  const resolvedPath = path.resolve(databasePath);
  const databaseName = path.basename(resolvedPath).toLowerCase();
  if (databaseName === 'yuvomi.db' || databaseName === 'oikos.db') {
    throw new Error('BANKING_DB_PATH must point to the Banking database, never Yuvomi Core data.');
  }

  return resolvedPath;
}

export function ensureDatabaseDirectory(databasePath = config.dbPath): string {
  const resolvedPath = assertBankingDatabasePath(databasePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  return resolvedPath;
}

export function listMigrations(
  migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY
): MigrationFile[] {
  const versions = new Set<number>();
  const migrations = fs.readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const match = /^(\d+)_([a-z0-9_-]+)\.sql$/i.exec(entry.name);
      if (!match) return null;

      const version = Number(match[1]);
      if (!Number.isSafeInteger(version) || version < 1) {
        throw new Error(`Invalid migration version in ${entry.name}.`);
      }
      if (versions.has(version)) {
        throw new Error(`Duplicate migration version ${version}.`);
      }
      versions.add(version);

      return {
        version,
        filename: entry.name,
        filePath: path.join(migrationsDirectory, entry.name)
      };
    })
    .filter((migration): migration is MigrationFile => migration !== null)
    .sort((left, right) => left.version - right.version);

  if (migrations.length === 0) {
    throw new Error('No database migrations were found.');
  }

  return migrations;
}

export function migrateDatabase(
  database: DatabaseSync,
  migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY
): number[] {
  database.exec('PRAGMA foreign_keys = ON;');
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = database
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number }>;
  const appliedVersions = new Set(appliedRows.map((row) => Number(row.version)));
  const newlyApplied: number[] = [];

  for (const migration of listMigrations(migrationsDirectory)) {
    if (appliedVersions.has(migration.version)) continue;

    database.exec('BEGIN IMMEDIATE;');
    try {
      database.exec(fs.readFileSync(migration.filePath, 'utf8'));
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(migration.version, new Date().toISOString());
      database.exec('COMMIT;');
      newlyApplied.push(migration.version);
    } catch (error) {
      try {
        database.exec('ROLLBACK;');
      } catch {
        // Preserve the original migration error.
      }
      throw new Error(`Database migration ${migration.filename} failed.`, { cause: error });
    }
  }

  return newlyApplied;
}

export function openBankingDatabase(
  databasePath = config.dbPath,
  migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY
): DatabaseSync {
  const resolvedPath = ensureDatabaseDirectory(databasePath);
  const database = new DatabaseSync(resolvedPath);

  try {
    database.exec('PRAGMA busy_timeout = 5000;');
    // The default rollback journal is portable across local Windows setups and
    // is sufficient while the sidecar has a single database writer.
    database.exec('PRAGMA journal_mode = DELETE;');
    migrateDatabase(database, migrationsDirectory);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

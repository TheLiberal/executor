// ---------------------------------------------------------------------------
// libSQL boot migration: copy the legacy single-valued `connection.access_group`
// restriction into the `connection_access_group` grant table (multiple groups
// per connection, OR semantics).
//
// This is the local/self-host arm (the cloud arm is a numbered Drizzle SQL
// migration with the same INSERT … SELECT). It runs once through the stamped
// `data_migration` ledger after boot-ensure has created the grant table.
// Idempotent by construction: the INSERT skips grant rows that already exist,
// and the legacy column is left in place (SQLite boot-ensure cannot drop
// columns) but is never read again. Nothing is deleted.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import {
  DataMigrationError,
  type SqliteDataMigration,
  type SqliteDataMigrationClient,
} from "./sqlite-data-migrations";

const MIGRATION_NAME = "2026-08-29-connection-access-group-grants";

const execute = (
  client: SqliteDataMigrationClient,
  stmt: string | { readonly sql: string; readonly args: readonly unknown[] },
) =>
  Effect.tryPromise({
    try: () => client.execute(stmt),
    catch: (cause) => new DataMigrationError({ migration: MIGRATION_NAME, cause }),
  });

const tableExists = (client: SqliteDataMigrationClient, table: string) =>
  execute(client, {
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    args: [table],
  }).pipe(Effect.map((result) => result.rows.length > 0));

const columnExists = (client: SqliteDataMigrationClient, table: string, column: string) =>
  execute(client, `PRAGMA table_info(${table})`).pipe(
    Effect.map((result) => result.rows.some((row) => String(row.name) === column)),
  );

/**
 * Backfill `connection_access_group` from `connection.access_group`. Returns
 * the number of grant rows inserted. Only org-owned rows are restriction
 * targets; a personal row carrying the column (impossible via the service
 * layer) is ignored rather than turned into a grant.
 */
export const runSqliteConnectionAccessGroupMigration = (
  client: SqliteDataMigrationClient,
): Effect.Effect<{ readonly inserted: number }, DataMigrationError> =>
  Effect.gen(function* () {
    // A database that predates access groups, or one whose boot-ensure did
    // not create the grant table, has nothing to copy.
    if (!(yield* tableExists(client, "connection"))) return { inserted: 0 };
    if (!(yield* tableExists(client, "connection_access_group"))) return { inserted: 0 };
    if (!(yield* columnExists(client, "connection", "access_group"))) return { inserted: 0 };

    const before = yield* execute(client, "SELECT COUNT(*) AS count FROM connection_access_group");
    yield* execute(client, {
      // `created_at` copies the connection's own `updated_at` so the value is
      // in whatever encoding the runtime writes timestamps with — no second
      // source of truth for the SQLite date format.
      sql: `INSERT INTO connection_access_group (row_id, tenant, integration, name, group_id, created_at)
        SELECT
          'cag_' || lower(hex(randomblob(12))),
          c.tenant, c.integration, c.name, c.access_group, c.updated_at
        FROM connection AS c
        WHERE c.access_group IS NOT NULL
          AND c.owner = 'org'
          AND NOT EXISTS (
            SELECT 1 FROM connection_access_group AS g
            WHERE g.tenant = c.tenant AND g.integration = c.integration
              AND g.name = c.name AND g.group_id = c.access_group
          )`,
      args: [],
    });
    const after = yield* execute(client, "SELECT COUNT(*) AS count FROM connection_access_group");
    return {
      inserted: Number(after.rows[0]?.count ?? 0) - Number(before.rows[0]?.count ?? 0),
    };
  });

/** Ledger entry for the local/self-host boot data-migration registry. */
export const connectionAccessGroupSqliteMigration: SqliteDataMigration = {
  name: MIGRATION_NAME,
  run: (client) => runSqliteConnectionAccessGroupMigration(client).pipe(Effect.asVoid),
};

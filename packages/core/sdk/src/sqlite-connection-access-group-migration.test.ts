import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { collectTables } from "./executor";
import { createSqliteTestFumaDb } from "./sqlite-test-db";
import {
  connectionAccessGroupSqliteMigration,
  runSqliteConnectionAccessGroupMigration,
} from "./sqlite-connection-access-group-migration";
import { runSqliteDataMigrations, type SqliteDataMigrationClient } from "./sqlite-data-migrations";

// ---------------------------------------------------------------------------
// The SQLite arm of the single-group → multi-group backfill. Every legacy
// `connection.access_group` value on an ORG connection becomes exactly one
// grant row; personal rows and unrestricted rows produce nothing; a second
// run is a no-op (the ledger skips it, and the INSERT is idempotent anyway).
// ---------------------------------------------------------------------------

const insertConnection = (
  client: SqliteDataMigrationClient,
  row: {
    rowId: string;
    tenant: string;
    owner: "org" | "user";
    subject: string;
    integration: string;
    name: string;
    accessGroup: string | null;
  },
) =>
  client.execute({
    sql: `INSERT INTO connection (row_id, tenant, owner, subject, integration, name, template, provider, item_ids, access_group, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'apiKey', 'memory', '{}', ?, ?, ?)`,
    args: [
      row.rowId,
      row.tenant,
      row.owner,
      row.subject,
      row.integration,
      row.name,
      row.accessGroup,
      1_700_000_000,
      1_700_000_123,
    ],
  });

const grantRows = (client: SqliteDataMigrationClient) =>
  Effect.promise(() =>
    client.execute(
      "SELECT tenant, integration, name, group_id, created_at FROM connection_access_group ORDER BY tenant, integration, name, group_id",
    ),
  ).pipe(
    Effect.map((result) =>
      result.rows.map((row) => ({
        tenant: String(row.tenant),
        integration: String(row.integration),
        name: String(row.name),
        group_id: String(row.group_id),
        created_at: Number(row.created_at),
      })),
    ),
  );

describe("runSqliteConnectionAccessGroupMigration", () => {
  it.effect("copies each org connection's legacy group into one grant row, idempotently", () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() }));
      yield* Effect.promise(async () => {
        await insertConnection(db.client, {
          rowId: "r1",
          tenant: "t1",
          owner: "org",
          subject: "",
          integration: "vercel",
          name: "main",
          accessGroup: "grp_finance",
        });
        await insertConnection(db.client, {
          rowId: "r2",
          tenant: "t2",
          owner: "org",
          subject: "",
          integration: "vercel",
          name: "main",
          accessGroup: "grp_other_tenant",
        });
        // Unrestricted org row: nothing to copy.
        await insertConnection(db.client, {
          rowId: "r3",
          tenant: "t1",
          owner: "org",
          subject: "",
          integration: "github",
          name: "main",
          accessGroup: null,
        });
        // A personal row is never a restriction target, even if the column
        // somehow carries a value.
        await insertConnection(db.client, {
          rowId: "r4",
          tenant: "t1",
          owner: "user",
          subject: "u1",
          integration: "vercel",
          name: "mine",
          accessGroup: "grp_finance",
        });
        // A grant that already exists (e.g. written by the new engine
        // before the migration ran) is not duplicated.
        await db.client.execute({
          sql: "INSERT INTO connection_access_group (row_id, tenant, integration, name, group_id, created_at) VALUES ('g0', 't1', 'vercel', 'main', 'grp_execs', 1)",
          args: [],
        });
      });

      const first = yield* runSqliteConnectionAccessGroupMigration(db.client);
      expect(first.inserted).toBe(2);
      expect(yield* grantRows(db.client)).toEqual([
        { tenant: "t1", integration: "vercel", name: "main", group_id: "grp_execs", created_at: 1 },
        // `created_at` is copied verbatim from the connection's `updated_at`.
        {
          tenant: "t1",
          integration: "vercel",
          name: "main",
          group_id: "grp_finance",
          created_at: 1_700_000_123,
        },
        {
          tenant: "t2",
          integration: "vercel",
          name: "main",
          group_id: "grp_other_tenant",
          created_at: 1_700_000_123,
        },
      ]);

      // Re-running the body is a no-op; the legacy column is left untouched.
      const second = yield* runSqliteConnectionAccessGroupMigration(db.client);
      expect(second.inserted).toBe(0);
      expect(yield* grantRows(db.client)).toHaveLength(3);
      const legacy = yield* Effect.promise(() =>
        db.client.execute("SELECT access_group FROM connection WHERE row_id = 'r1'"),
      );
      expect(legacy.rows[0]!.access_group).toBe("grp_finance");

      yield* Effect.promise(() => db.close());
    }),
  );

  it.effect("runs through the stamped ledger and is skipped on the next boot", () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() }));
      yield* Effect.promise(() =>
        insertConnection(db.client, {
          rowId: "r1",
          tenant: "t1",
          owner: "org",
          subject: "",
          integration: "vercel",
          name: "main",
          accessGroup: "grp_finance",
        }),
      );
      const applied = yield* runSqliteDataMigrations(db.client, [
        connectionAccessGroupSqliteMigration,
      ]);
      expect(applied).toEqual([connectionAccessGroupSqliteMigration.name]);
      expect(yield* grantRows(db.client)).toHaveLength(1);
      const again = yield* runSqliteDataMigrations(db.client, [
        connectionAccessGroupSqliteMigration,
      ]);
      expect(again).toEqual([]);
      yield* Effect.promise(() => db.close());
    }),
  );

  it.effect("is a no-op on a database without the legacy column or the grant table", () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() }));
      yield* Effect.promise(() => db.client.execute("DROP TABLE connection_access_group"));
      const result = yield* runSqliteConnectionAccessGroupMigration(db.client);
      expect(result.inserted).toBe(0);
      yield* Effect.promise(() => db.close());
    }),
  );
});

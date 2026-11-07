import type { Pool, PoolClient } from "pg";

type Connection = Pool | PoolClient;

// Also imported by the standalone CLI: keep this module free of Next/server-only imports.
export async function cleanupRetention(db: Connection) {
  const { rows } = await db.query<{ id: string; retention_days: number }>(
    "select id, retention_days from projects",
  );
  for (const project of rows) {
    // Plans do not exist yet: the project's own retention is the effective retention.
    for (const table of ["events", "visits"] as const) {
      const column = table === "events" ? "occurred_at" : "last_seen_at";
      await deleteBatches(
        db,
        `delete from ${table} where ctid in (
          select ctid from ${table}
          where project_id = $1 and ${column} < now() - ($2 * interval '1 day') limit 5000
        )`,
        [project.id, project.retention_days],
      );
    }
  }
}

export async function purgeMaintenance(db: Connection) {
  // Add future feature-specific purge steps here. Each batch commits independently.
  for (const [table, predicate] of [
    ['"session"', "expires_at < now()"],
    ["verification", "expires_at < now()"],
    ["invitation", "coalesce(accepted_at, expires_at) < now() - interval '30 days'"],
    ["audit_log", "created_at < now() - interval '365 days'"],
    ["rate_limits", "expires_at < now()"],
    ["jobs", "finished_at < now() - interval '7 days'"],
    ["email_outbox", "created_at < now() - interval '30 days'"],
  ]) {
    await deleteBatches(
      db,
      `delete from ${table} where ctid in (select ctid from ${table} where ${predicate} limit 5000)`,
    );
  }
}

async function deleteBatches(db: Connection, query: string, values: unknown[] = []) {
  let deleted;
  do {
    const result = await db.query(query, values);
    deleted = result.rowCount ?? 0;
  } while (deleted === 5000);
}

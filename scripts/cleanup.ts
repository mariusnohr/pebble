import { config } from "dotenv";
import { Pool } from "pg";
config({ path: ".env.local", quiet: true });
config({ quiet: true });
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const { rows } = await pool.query("select id, retention_days from projects");
  for (const project of rows) {
    // Bound each delete so maintenance does not hold long-running locks.
    for (const table of ["events", "visits"] as const) {
      const column = table === "events" ? "occurred_at" : "last_seen_at";
      let deleted;
      do {
        const result = await pool.query(
          `delete from ${table} where ctid in (select ctid from ${table} where project_id = $1 and ${column} < now() - ($2 * interval '1 day') limit 5000)`,
          [project.id, project.retention_days],
        );
        deleted = result.rowCount ?? 0;
      } while (deleted === 5000);
    }
  }
  await pool.query("delete from admin_sessions where expires_at < now()");
  await pool.query("delete from rate_limits where expires_at < now()");
  console.log("Retention cleanup complete.");
} finally {
  await pool.end();
}

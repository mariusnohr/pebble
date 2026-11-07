import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { LEGACY_ORGANIZATION_ID } from "../src/server/legacy-organization";

export function requireTestDatabaseUrl(value = process.env.TEST_DATABASE_URL) {
  const message =
    "Set TEST_DATABASE_URL to a dedicated database whose name starts with pebble_test.";
  if (!value) throw new Error(message);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(message);
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !/^\/pebble_test[a-zA-Z0-9_-]*$/.test(url.pathname) ||
    url.searchParams.has("database") ||
    url.searchParams.has("dbname")
  ) {
    throw new Error(message);
  }
  return value;
}

export async function assertTestDatabase(pool: Pool) {
  const { rows } = await pool.query<{ name: string }>("select current_database() as name");
  assert.match(rows[0].name, /^pebble_test[a-zA-Z0-9_-]*$/, "Refusing a non-test database");
}

async function tableCounts(pool: Pool) {
  const { rows } = await pool.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public' order by tablename",
  );
  const counts: Record<string, string> = {};
  for (const { tablename } of rows) {
    const identifier = `"${tablename.replaceAll('"', '""')}"`;
    const result = await pool.query<{ count: string }>(`select count(*) from public.${identifier}`);
    counts[tablename] = result.rows[0].count;
  }
  return counts;
}

export async function rehearseCutover(pool: Pool, log: (line: string) => void = console.log) {
  await assertTestDatabase(pool);
  const before = await tableCounts(pool);
  for (const table of [
    "projects",
    "events",
    "visits",
    "project_api_keys",
    "admin_sessions",
    "rate_limits",
  ]) {
    assert.ok(table in before, `Restore the legacy database first: missing ${table}`);
  }
  log("Cutover rehearsal: existing public-table row counts (before -> after)");
  await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
  const after = await tableCounts(pool);
  for (const [table, count] of Object.entries(before)) {
    log(`${table}: ${count} -> ${after[table] ?? "MISSING"}`);
  }
  for (const [table, count] of Object.entries(before)) {
    assert.equal(after[table], count, `Row count changed for ${table}`);
  }
  const legacy = await pool.query<{ name: string; slug: string; plan_override: string }>(
    "select name, slug, plan_override from organization where id = $1",
    [LEGACY_ORGANIZATION_ID],
  );
  assert.deepEqual(legacy.rows, [{ name: "Pebble", slug: "pebble", plan_override: "business" }]);
  const unassigned = await pool.query<{ count: string }>(
    "select count(*) from projects where organization_id is distinct from $1::uuid",
    [LEGACY_ORGANIZATION_ID],
  );
  assert.equal(unassigned.rows[0].count, "0", "Some projects are outside the legacy organization");
  log(
    `Legacy organization: Pebble (pebble), business override; ${after.projects}/${after.projects} projects assigned.`,
  );
  log("PASS: all pre-existing table counts are unchanged.");
  return { before, after };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = new Pool({
    connectionString: requireTestDatabaseUrl(),
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 120000,
  });
  try {
    await rehearseCutover(pool);
  } catch {
    // Never print connection strings, restored data or raw database errors.
    console.error("FAIL: migration, row-count or legacy-organization check failed.");
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

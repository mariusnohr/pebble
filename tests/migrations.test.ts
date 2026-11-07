import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { requireTestDatabaseUrl } from "../scripts/rehearse-cutover";

// Deliberately conservative throughout M1, including newly created tables.
// Lift this guard only in the M2 contract step, when rollback support ends.
function assertAdditiveMigration(source: string) {
  const sql = source
    .replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\//g, (token) =>
      token.startsWith('"') ? token : " ",
    )
    .replace(/\s+/g, " ");
  assert.doesNotMatch(
    sql,
    /\b(?:DROP|RENAME|TRUNCATE)\b/i,
    "M1 cannot remove or rename schema/data",
  );
  assert.doesNotMatch(
    sql,
    /\bALTER\s+(?:COLUMN\s+)?(?:"(?:""|[^"])+"|[\w]+)\s+(?:SET\s+DATA\s+)?TYPE\b/i,
    "M1 cannot retype columns",
  );
  assert.doesNotMatch(sql, /\bSET\s+NOT\s+NULL\b/i, "M1 cannot require existing nullable columns");
  for (const statement of sql.split(";")) {
    if (!/\bALTER\s+TABLE\b/i.test(statement)) continue;
    // ADD ... NOT NULL is only compatible with old inserts when it has a default.
    for (const addition of statement.split(/\bADD\s+(?:COLUMN\s+)?/i).slice(1)) {
      if (/^\s*CONSTRAINT\b/i.test(addition)) continue;
      if (/\bNOT\s+NULL\b/i.test(addition)) {
        assert.match(addition, /\bDEFAULT\b/i, "New required columns need a default in M1");
      }
    }
  }
}

test("every migration after 0000 stays additive during the rollback window", () => {
  const folder = new URL("../drizzle/", import.meta.url);
  for (const file of readdirSync(folder)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort()) {
    if (file.startsWith("0000_")) continue;
    assert.doesNotThrow(
      () => assertAdditiveMigration(readFileSync(new URL(file, folder), "utf8")),
      file,
    );
  }
});

test("the guard rejects destructive changes to legacy tables, columns, indexes and constraints", () => {
  for (const sql of [
    'DROP TABLE "admin_sessions";',
    'ALTER TABLE "projects" DROP COLUMN "name";',
    'ALTER TABLE "projects" DROP CONSTRAINT "retention_range";',
    'DROP INDEX "events_project_time";',
    'ALTER TABLE "projects" RENAME TO "old_projects";',
    'ALTER TABLE "projects" RENAME COLUMN "name" TO "title";',
    'ALTER INDEX "events_project_time" RENAME TO "old_index";',
    'ALTER TABLE "projects" ALTER COLUMN "id" TYPE text;',
    "alter table public.projects alter id set data type text;",
    'ALTER TABLE "projects" ALTER COLUMN "organization_id" SET NOT NULL;',
    'ALTER TABLE "projects" ADD COLUMN "required" text NOT NULL;',
    'ALTER TABLE ONLY "public"."projects" ALTER COLUMN "id" /* comment */ TYPE text;',
    'ALTER TABLE "projects" ADD COLUMN "optional" text, ALTER COLUMN "origins"\nSET\nNOT NULL;',
    'TRUNCATE "events";',
  ]) {
    assert.throws(() => assertAdditiveMigration(sql), { name: "AssertionError" }, sql);
  }
});

test("the guard accepts new tables, nullable columns, defaulted columns and comments", () => {
  assertAdditiveMigration(`
    -- DROP is forbidden; this is a comment.
    /* RENAME and ALTER COLUMN name TYPE are documentation. */
    CREATE TABLE "organization" ("id" uuid PRIMARY KEY, "name" text NOT NULL);
    ALTER TABLE "projects" ADD COLUMN "organization_id" uuid;
    ALTER TABLE "projects" ADD COLUMN "agent_context" text DEFAULT '' NOT NULL;
    ALTER TABLE "projects" ADD CONSTRAINT "context_length" CHECK (length(agent_context) <= 4000);
    CREATE INDEX "projects_org" ON "projects" ("organization_id");
    INSERT INTO "organization" ("name") VALUES ('DROP RENAME SET NOT NULL');
  `);
});

test("cutover tools refuse missing, non-Postgres and non-test database URLs", () => {
  for (const value of [
    "",
    "invalid",
    "https://localhost/pebble_test",
    "postgresql://localhost/pebble",
    "postgresql://localhost/pebble_test?database=pebble",
    "postgresql://localhost/pebble_test?dbname=pebble",
    "postgresql://localhost/pebble_test/other",
  ]) {
    assert.throws(() => requireTestDatabaseUrl(value), /dedicated database/);
  }
  for (const value of [
    "postgresql://localhost/pebble_test",
    "postgres://localhost/pebble_test_cutover",
  ]) {
    assert.equal(requireTestDatabaseUrl(value), value);
  }
});

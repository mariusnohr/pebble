import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { getDb, closeDb } from "../../src/db";
import {
  M1_MIGRATION,
  migrateThrough,
  migrateWithConfirmation,
} from "../../scripts/migration-boundary";
import { assertTestDatabase, requireTestDatabaseUrl } from "../../scripts/rehearse-cutover";
import { LEGACY_ORGANIZATION_ID } from "../../src/server/legacy-organization";
import { hashToken, randomToken } from "../../src/server/crypto";
import * as legacy from "./fixtures/legacy-schema";
import * as m1 from "./fixtures/m1-schema";

process.env.DATABASE_URL = requireTestDatabaseUrl();
process.env.APP_URL = "http://localhost:3000";
process.env.BETTER_AUTH_SECRET = randomUUID();
delete process.env.ADMIN_PASSWORD_HASH;
const db = getDb();
const pool = db.$client;
const oldDb = drizzle(pool);
const origin = "https://legacy.example";
const ownerId = randomUUID(),
  otherId = randomUUID(),
  legacyProject = randomUUID();
const token = `pb_${randomToken()}`;
const confirmation = "Disposable contract fixture; not a production confirmation";

async function snapshot() {
  const { rows } = await pool.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public' order by tablename",
  );
  const result: Record<string, Record<string, unknown>[]> = {};
  for (const { tablename } of rows) {
    const identifier = `"${tablename.replaceAll('"', '""')}"`;
    const data = await pool.query(`select to_jsonb(t) as row from public.${identifier} t`);
    result[tablename] = data.rows.map(({ row }) => row);
  }
  return result;
}
function sorted(data: Awaited<ReturnType<typeof snapshot>>) {
  return Object.fromEntries(
    Object.entries(data).map(([table, rows]) => [
      table,
      rows.map((row) => JSON.stringify(row)).sort(),
    ]),
  );
}
async function journal() {
  return (await pool.query("select * from drizzle.__drizzle_migrations order by id")).rows;
}
function databaseError(message: RegExp) {
  return (error: unknown): boolean => {
    // Drizzle wraps the PostgreSQL guard failure in a query error.
    const cause = (error as { cause?: Error }).cause ?? error;
    return cause instanceof Error && message.test(cause.message);
  };
}
async function expectBlocked(message: RegExp, reference = confirmation) {
  const before = sorted(await snapshot());
  const migrations = await journal();
  await assert.rejects(migrateWithConfirmation(pool, reference), databaseError(message));
  assert.deepEqual(sorted(await snapshot()), before);
  assert.deepEqual(await journal(), migrations);
}

async function waitForProjectLock(pid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query(
      `select 1 from pg_locks where pid = $1 and relation = 'projects'::regclass
       and mode = 'AccessExclusiveLock' and not granted`,
      [pid],
    );
    if (rows.length) return;
    await delay(10);
  }
  assert.fail("The contract migration did not wait for the in-flight M1 project writes");
}

async function contractWithM1Writes(expected: Awaited<ReturnType<typeof snapshot>>) {
  // A single-connection pool identifies the real migrator's backend without sleeps.
  const migrationPool = new Pool({
    connectionString: requireTestDatabaseUrl(),
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  });
  const creator = await pool.connect();
  const updater = await pool.connect();
  let migration: Promise<PromiseSettledResult<void>> | undefined;

  async function auditAndCommit(client: PoolClient, projectId: string, action: string) {
    const auditId = randomUUID();
    // Matches M1's project transaction: mutate the project, then insert its audit.
    await client.query(
      `insert into audit_log (id, organization_id, actor_user_id, actor_label, action, target_type, target_id)
       values ($1, $2, $3, 'M1 owner', $4, 'project', $5)`,
      [auditId, LEGACY_ORGANIZATION_ID, ownerId, action, projectId],
    );
    for (const [table, id] of [
      ["projects", projectId],
      ["audit_log", auditId],
    ] as const) {
      const { rows } = await client.query<{ row: Record<string, unknown> }>(
        `select to_jsonb(t) as row from ${table} t where id = $1`,
        [id],
      );
      expected[table] = expected[table].filter((row) => row.id !== id);
      expected[table].push(rows[0].row);
    }
    await client.query("commit");
  }

  try {
    for (const client of [creator, updater]) {
      await client.query("begin");
      await client.query("set local lock_timeout = '5s'");
    }
    // Pause an INSERT after its table lock but before its organization FK check.
    await creator.query("lock table projects in row exclusive mode");
    // Pause an UPDATE at the point where the next M1 statement inserts its audit.
    await drizzle(updater)
      .update(m1.projects)
      .set({ name: "Updated by in-flight M1" })
      .where(eq(m1.projects.id, legacyProject));
    const {
      rows: [{ pid }],
    } = await migrationPool.query<{ pid: number }>("select pg_backend_pid() as pid");
    migration = migrateWithConfirmation(migrationPool, confirmation).then(
      () => ({ status: "fulfilled", value: undefined }),
      (reason: unknown) => ({ status: "rejected", reason }),
    );
    // The guard has taken its organization lock and is now waiting for both writers.
    await waitForProjectLock(pid);
    const writes = await Promise.allSettled([
      (async () => {
        const [project] = await drizzle(creator)
          .insert(m1.projects)
          .values({
            name: "Created by in-flight M1",
            origins: [origin],
            organizationId: LEGACY_ORGANIZATION_ID,
          })
          .returning();
        await auditAndCommit(creator, project.id, "project.created");
      })(),
      auditAndCommit(updater, legacyProject, "project.updated"),
    ]);
    for (const result of writes) if (result.status === "rejected") throw result.reason;
    const result = await migration;
    if (result.status === "rejected") throw result.reason;
  } finally {
    // Release blockers even on a regression, then drain the handled migration promise.
    await Promise.allSettled([creator.query("rollback"), updater.query("rollback")]);
    creator.release();
    updater.release();
    await migration;
    await migrationPool.end();
  }
}

before(async () => {
  await assertTestDatabase(pool);
  // Like cutover.test.ts, this file owns a disposable database, never a restored dump.
  await pool.query(
    "drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public",
  );
  await migrateThrough(pool, M1_MIGRATION);
  await pool.query(
    `insert into "user" (id, name, email, email_verified) values ($1, 'Owner', $2, true)`,
    [ownerId, `owner-${ownerId}@example.com`],
  );
  await pool.query(
    "insert into organization (id, name, slug, created_at) values ($1, 'Other', 'other', now())",
    [otherId],
  );
  await pool.query(
    `insert into member (organization_id, user_id, role, created_at) values ($1, $2, 'owner', now())`,
    [otherId, ownerId],
  );
  for (const [index, organizationId] of [null, LEGACY_ORGANIZATION_ID, otherId].entries()) {
    const [project] = await oldDb
      .insert(m1.projects)
      .values({
        id: index === 0 ? legacyProject : randomUUID(),
        organizationId,
        name: `Preserved project ${index}`,
        origins: [origin, "https://another.example"],
        timezone: "Europe/Oslo",
        retentionDays: 730,
        paused: index === 2,
        agentContext: "Preserve this context",
      })
      .returning();
    const visitorId = randomUUID(),
      visitId = randomUUID(),
      now = new Date();
    await oldDb.insert(legacy.visits).values({
      projectId: project.id,
      id: visitId,
      visitorId,
      startedAt: now,
      lastSeenAt: now,
      browserSeenAt: now,
      entryPath: "/old",
      currentPath: "/old",
      utmSource: "newsletter",
    });
    await oldDb.insert(legacy.events).values([
      {
        projectId: project.id,
        id: randomUUID(),
        type: "pageview",
        source: "browser",
        occurredAt: now,
        visitorId,
        visitId,
        path: "/old",
      },
      {
        projectId: project.id,
        id: randomUUID(),
        type: "event",
        source: "server",
        occurredAt: now,
        name: "completed",
        properties: { amount: 42 },
      },
    ]);
    await oldDb.insert(legacy.apiKeys).values({
      projectId: project.id,
      name: "Existing key",
      prefix: "pb_fixture",
      tokenHash: index === 0 ? hashToken(token) : randomUUID(),
      lastUsedAt: now,
      revokedAt: index === 2 ? now : null,
    });
  }
  await oldDb.insert(legacy.adminSessions).values({
    tokenHash: "obsolete-fixture",
    passwordVersion: "obsolete-fixture",
    expiresAt: new Date(),
  });
  for (const org of [LEGACY_ORGANIZATION_ID, otherId]) {
    await pool.query(
      `insert into usage_periods (organization_id, period, events, dropped_events, ai_credits,
       warned80_at, warned100_at, stopped_at) values ($1, '2026-10', 123, 4, 5, now(), now(), now())`,
      [org],
    );
  }
});
after(closeDb);

test("F3 contracts atomically, preserves all tenant data, and supports the running M1 release", async (t) => {
  await t.test("missing owner confirmation leaves every row and migration unchanged", async () => {
    await expectBlocked(/F3_CONTRACT_CONFIRMATION/, "");
    await expectBlocked(/F3_CONTRACT_CONFIRMATION/, "   ");
  });
  await t.test("a missing legacy organization cannot be silently recreated", async () => {
    // Temporarily remove its dependent fixture rows, then restore them in the same test.
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("delete from organization where id = $1", [LEGACY_ORGANIZATION_ID]);
      // Exercise the checked-in SQL guard in this rollback-only fixture transaction.
      const contract = readMigrationFiles({ migrationsFolder: "drizzle" })[5];
      await client.query("select set_config('pebble.f3_contract_confirmation', $1, true)", [
        confirmation,
      ]);
      await assert.rejects(
        client.query(contract.sql[0]),
        databaseError(/requires the legacy Pebble organization/),
      );
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
  await t.test("unclaimed, non-owner and unverified claims are refused", async () => {
    await expectBlocked(/requires a verified owner/);
    await pool.query(
      "insert into member (organization_id, user_id, role, created_at) values ($1, $2, 'admin', now())",
      [LEGACY_ORGANIZATION_ID, ownerId],
    );
    await expectBlocked(/requires a verified owner/);
    await pool.query("update member set role = 'owner' where organization_id = $1", [
      LEGACY_ORGANIZATION_ID,
    ]);
    await pool.query('update "user" set email_verified = false where id = $1', [ownerId]);
    await expectBlocked(/requires a verified owner/);
    await pool.query('update "user" set email_verified = true where id = $1', [ownerId]);
  });
  await t.test(
    "an unexpected dependency rolls back the backfill and constraint instead of cascading",
    async () => {
      await pool.query("create view contract_dependency as select token_hash from admin_sessions");
      try {
        await expectBlocked(/other objects depend on it/);
        const column = await pool.query(
          "select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'projects' and column_name = 'organization_id'",
        );
        assert.equal(column.rows[0].is_nullable, "YES");
      } finally {
        await pool.query("drop view contract_dependency");
      }
    },
  );
  await t.test(
    "concurrent M1 writes commit through contraction; renamed ownership and every row are preserved",
    async () => {
      await pool.query("update organization set name = 'Renamed', slug = 'renamed' where id = $1", [
        LEGACY_ORGANIZATION_ID,
      ]);
      const expected = await snapshot();
      delete expected.admin_sessions;
      await contractWithM1Writes(expected);
      for (const project of expected.projects) project.organization_id ??= LEGACY_ORGANIZATION_ID;
      assert.deepEqual(sorted(await snapshot()), sorted(expected));
      const column = await pool.query(
        "select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'projects' and column_name = 'organization_id'",
      );
      assert.equal(column.rows[0].is_nullable, "NO");
      await assert.rejects(
        oldDb.insert(m1.projects).values({ name: "No owner", origins: [origin] }),
        databaseError(/not-null constraint/),
      );
      const migrations = await journal();
      await migrateWithConfirmation(pool); // No approval is needed again for an applied migration.
      assert.deepEqual(sorted(await snapshot()), sorted(expected));
      assert.deepEqual(await journal(), migrations);
    },
  );
  await t.test(
    "M1 project creation, membership reads and both existing transports still work",
    async () => {
      const [created] = await oldDb
        .insert(m1.projects)
        .values({
          name: "Created by running M1",
          origins: [origin],
          organizationId: LEGACY_ORGANIZATION_ID,
        })
        .returning();
      const { resolveProject } = await import("../../src/server/tenancy");
      assert.equal(
        (await resolveProject("renamed", created.id, { id: ownerId, emailVerified: true })).project
          .id,
        created.id,
      );
      const { POST: collect } = await import("../../src/app/api/v1/collect/route");
      const { POST: ingest } = await import("../../src/app/api/v1/events/route");
      const browserId = randomUUID(),
        serverId = randomUUID();
      const browser = await collect(
        new Request(`${process.env.APP_URL}/api/v1/collect`, {
          method: "POST",
          headers: { origin, "user-agent": "Mozilla/5.0 Chrome/130.0.0.0" },
          body: JSON.stringify({
            projectId: legacyProject,
            events: [
              {
                id: browserId,
                type: "pageview",
                path: "/still-tracking",
                visitorId: randomUUID(),
                visitId: randomUUID(),
              },
            ],
          }),
        }),
      );
      const server = await ingest(
        new Request(`${process.env.APP_URL}/api/v1/events`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({
            events: [{ id: serverId, type: "event", name: "still_tracking" }],
          }),
        }),
      );
      for (const response of [browser, server]) {
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { accepted: 1, duplicates: 0, ignored: 0 });
      }
      for (const id of [browserId, serverId])
        assert.equal(
          (await oldDb.select().from(legacy.events).where(eq(legacy.events.id, id))).length,
          1,
        );
      const usage = await pool.query(
        "select events from usage_periods where organization_id = $1 and period = $2",
        [LEGACY_ORGANIZATION_ID, new Date().toISOString().slice(0, 7)],
      );
      assert.equal(usage.rows[0].events, "2");
    },
  );
  await t.test(
    "readiness, scheduled purge and the cleanup CLI need no legacy admin table or password",
    async () => {
      const { GET: ready } = await import("../../src/app/api/ready/route");
      assert.equal((await ready()).status, 200);
      const { purgeMaintenance } = await import("../../src/server/jobs/cleanup");
      const { enqueueSchedules, runNextJob } = await import("../../src/server/jobs/queue");
      await enqueueSchedules(pool);
      assert.equal(await runNextJob(pool, "purge", purgeMaintenance, { log: () => {} }), true);
      const { stdout } = await promisify(execFile)("pnpm", ["db:cleanup"], {
        env: { ...process.env, ADMIN_PASSWORD_HASH: "" },
      });
      assert.match(stdout, /Retention cleanup complete/);
      assert.equal((await ready()).status, 200);
    },
  );
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { EXPAND_MIGRATION, migrateThrough } from "../../scripts/migration-boundary";
import { Pool } from "pg";
import * as legacy from "./fixtures/legacy-schema";
import { organization, projects, usagePeriods, auditLog, user, member } from "../../src/db/schema";
import { getDb, closeDb } from "../../src/db";
import { messageSchema } from "../../src/lib/contracts";
import { ingest } from "../../src/server/ingestion";
import {
  assertTestDatabase,
  requireTestDatabaseUrl,
  rehearseCutover,
} from "../../scripts/rehearse-cutover";
import { LEGACY_ORGANIZATION_ID } from "../../src/server/legacy-organization";
import { backfillLegacyProjects } from "../../src/server/jobs/legacy-projects";
import { enqueueSchedules, runNextJob, TICK_MS } from "../../src/server/jobs/queue";

const pool = new Pool({ connectionString: requireTestDatabaseUrl(), max: 3 });
process.env.DATABASE_URL = requireTestDatabaseUrl();
process.env.APP_URL = "http://localhost:3000";
process.env.BETTER_AUTH_SECRET = randomUUID();
const oldDb = drizzle(pool, { schema: legacy });
const db = drizzle(pool);
const migrations = readMigrationFiles({ migrationsFolder: "drizzle" });
const projectIds: string[] = [randomUUID(), randomUUID()];
const origin = "https://legacy.example";
const now = new Date();

async function legacyRows() {
  // Explicit legacy projections detect changed values as well as missing rows.
  return {
    projects: await oldDb.select().from(legacy.projects).orderBy(legacy.projects.id),
    events: await oldDb
      .select()
      .from(legacy.events)
      .orderBy(legacy.events.projectId, legacy.events.id),
    visits: await oldDb
      .select()
      .from(legacy.visits)
      .orderBy(legacy.visits.projectId, legacy.visits.id),
    keys: await oldDb.select().from(legacy.apiKeys).orderBy(legacy.apiKeys.id),
    sessions: await oldDb
      .select()
      .from(legacy.adminSessions)
      .orderBy(legacy.adminSessions.tokenHash),
    limits: await oldDb.select().from(legacy.rateLimits).orderBy(legacy.rateLimits.key),
  };
}

let originalRows: Awaited<ReturnType<typeof legacyRows>>;
let resetStarted = false;
before(async () => {
  // This file destroys its dedicated test database. The suite runs serially;
  // never point it at the owner's restored dump used by db:rehearse.
  await assertTestDatabase(pool);
  resetStarted = true;
  await pool.query(
    "drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public",
  );
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const statement of migrations[0].sql) await client.query(statement);
    // Record only 0000 using Drizzle's journal shape, so the real migrator
    // subsequently applies exactly the remaining checked-in migrations.
    await client.query("create schema drizzle");
    await client.query(
      "create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)",
    );
    await client.query(
      "insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)",
      [migrations[0].hash, migrations[0].folderMillis],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  for (const [i, id] of projectIds.entries()) {
    await oldDb.insert(legacy.projects).values({
      id,
      name: `Legacy ${i}`,
      origins: [origin],
      timezone: i ? "Europe/Oslo" : "UTC",
      retentionDays: i ? 730 : 90,
      paused: Boolean(i),
    });
    const visitId = randomUUID(),
      visitorId = randomUUID();
    await oldDb.insert(legacy.visits).values({
      projectId: id,
      id: visitId,
      visitorId,
      startedAt: now,
      lastSeenAt: now,
      browserSeenAt: now,
      entryPath: "/old",
      currentPath: "/old",
      browser: "Firefox",
      os: "Linux",
      device: "Desktop",
      referrer: "example.com",
      language: "en",
      utmSource: "newsletter",
    });
    await oldDb.insert(legacy.events).values([
      {
        projectId: id,
        id: randomUUID(),
        type: "pageview",
        source: "browser",
        occurredAt: now,
        visitId,
        visitorId,
        path: "/old",
      },
      {
        projectId: id,
        id: randomUUID(),
        type: "event",
        source: "server",
        occurredAt: now,
        name: "completed",
        properties: { value: 42 },
      },
    ]);
    await oldDb.insert(legacy.apiKeys).values({
      projectId: id,
      name: "Legacy ingest",
      prefix: "pb_legacy",
      tokenHash: `legacy-key-${i}`,
      lastUsedAt: now,
      revokedAt: i ? now : null,
    });
    await oldDb.insert(legacy.adminSessions).values({
      tokenHash: `legacy-session-${i}`,
      passwordVersion: "legacy-password-version",
      expiresAt: new Date(now.getTime() + (i ? -86400000 : 86400000)),
    });
    await oldDb.insert(legacy.rateLimits).values({
      key: `legacy-bucket-${i}`,
      count: i + 3,
      expiresAt: new Date(now.getTime() + 60000),
    });
  }
  originalRows = await legacyRows();
});

after(async () => {
  // Leave the schema at the expand boundary; subsequent suites prepare contraction.
  try {
    if (!resetStarted) return;
    await pool.query("delete from projects");
    await pool.query("delete from admin_sessions");
    await pool.query("delete from rate_limits");
    await pool.query("delete from jobs");
    await pool.query("delete from organization where id <> $1", [LEGACY_ORGANIZATION_ID]);
  } finally {
    await pool.end();
    await closeDb();
  }
});

test("expand preserves the legacy release, rehearsal counts and rollback writes", async (t) => {
  await t.test(
    "rehearsal applies only through the expand boundary and preserves every legacy value",
    async () => {
      const lines: string[] = [];
      const result = await rehearseCutover(pool, (line) => lines.push(line));
      assert.equal(result.before.projects, "2");
      assert.equal(result.before.events, "4");
      assert.equal(result.before.visits, "2");
      assert.match(lines.at(-1)!, /^PASS:/);
      assert.deepEqual(await legacyRows(), originalRows);
      assert.deepEqual(
        await db
          .select({
            id: organization.id,
            name: organization.name,
            slug: organization.slug,
            plan: organization.planOverride,
            ai: organization.aiEnabled,
          })
          .from(organization),
        [
          {
            id: LEGACY_ORGANIZATION_ID,
            name: "Pebble",
            slug: "pebble",
            plan: "business",
            ai: true,
          },
        ],
      );
      const assigned = await db.select().from(projects);
      assert.equal(assigned.length, 2);
      assert.ok(
        assigned.every(
          (project) =>
            project.organizationId === LEGACY_ORGANIZATION_ID && project.agentContext === "",
        ),
      );
      assert.deepEqual(await db.select().from(auditLog), []);
      assert.deepEqual(await db.select().from(usagePeriods), []);
      await migrateThrough(pool, EXPAND_MIGRATION);
      // Replay just the migration's data step, independently of journal skipping.
      const expand = migrations[2].sql;
      const dataStep = expand.findIndex((statement) =>
        statement.includes("-- Legacy organization data step:"),
      );
      assert.ok(dataStep >= 0);
      for (const statement of expand.slice(dataStep)) await pool.query(statement);
      assert.deepEqual(await legacyRows(), originalRows);
      const repeated = await rehearseCutover(pool, () => {});
      assert.deepEqual(repeated.before, repeated.after);
    },
  );

  await t.test("old admin-session insert/select and ingest-key lookup still work", async () => {
    await oldDb.insert(legacy.adminSessions).values({
      tokenHash: "rollback-session",
      passwordVersion: "rollback-password",
      expiresAt: new Date(now.getTime() + 7 * 86400000),
    });
    const sessions = await oldDb
      .select()
      .from(legacy.adminSessions)
      .where(
        and(
          eq(legacy.adminSessions.tokenHash, "rollback-session"),
          eq(legacy.adminSessions.passwordVersion, "rollback-password"),
          gt(legacy.adminSessions.expiresAt, new Date()),
        ),
      )
      .limit(1);
    assert.equal(sessions.length, 1);
    const [key] = await oldDb
      .select()
      .from(legacy.apiKeys)
      .innerJoin(legacy.projects, eq(legacy.apiKeys.projectId, legacy.projects.id))
      .where(and(eq(legacy.apiKeys.tokenHash, "legacy-key-0"), isNull(legacy.apiKeys.revokedAt)));
    assert.equal(key.projects.id, projectIds[0]);
    assert.deepEqual(key.projects.origins, [origin]);
  });

  await t.test(
    "old project creation, browser event insert and visit upsert still work",
    async () => {
      const [created] = await oldDb
        .insert(legacy.projects)
        .values({ name: "Rollback project", origins: [origin] })
        .returning();
      projectIds.push(created.id);
      const [expanded] = await db.select().from(projects).where(eq(projects.id, created.id));
      assert.equal(expanded.organizationId, null);
      assert.equal(expanded.agentContext, "");
      const visitorId = randomUUID(),
        visitId = randomUUID();
      for (let i = 0; i < 2; i++) {
        const at = new Date(now.getTime() + i * 1000);
        await oldDb.transaction(async (tx) => {
          const [project] = await tx
            .select()
            .from(legacy.projects)
            .where(eq(legacy.projects.id, created.id))
            .for("share");
          assert.ok(project.origins.includes(origin));
          const inserted = await tx
            .insert(legacy.events)
            .values({
              id: randomUUID(),
              projectId: created.id,
              source: "browser",
              type: "pageview",
              occurredAt: at,
              visitorId,
              visitId,
              path: `/rollback-${i}`,
            })
            .onConflictDoNothing()
            .returning({ id: legacy.events.id });
          assert.equal(inserted.length, 1);
          await tx
            .insert(legacy.visits)
            .values({
              projectId: created.id,
              id: visitId,
              visitorId,
              startedAt: at,
              lastSeenAt: at,
              browserSeenAt: at,
              entryPath: `/rollback-${i}`,
              currentPath: `/rollback-${i}`,
            })
            .onConflictDoUpdate({
              target: [legacy.visits.projectId, legacy.visits.id],
              set: {
                startedAt: sql`least(${legacy.visits.startedAt}, ${at})`,
                lastSeenAt: sql`greatest(${legacy.visits.lastSeenAt}, ${at})`,
                browserSeenAt: at,
                currentPath: `/rollback-${i}`,
              },
              setWhere: eq(legacy.visits.visitorId, visitorId),
            });
        });
      }
      const visits = await oldDb
        .select()
        .from(legacy.visits)
        .where(eq(legacy.visits.projectId, created.id));
      assert.equal(visits.length, 1);
      assert.equal(visits[0].entryPath, "/rollback-0");
      assert.equal(visits[0].currentPath, "/rollback-1");
      assert.equal(visits[0].lastSeenAt.getTime(), now.getTime() + 1000);
      assert.equal(
        (await oldDb.select().from(legacy.events).where(eq(legacy.events.projectId, created.id)))
          .length,
        2,
      );
    },
  );

  await t.test(
    "one scheduled runner tick backfills NULL projects and preserves other tenants",
    async () => {
      const [other] = await db
        .insert(organization)
        .values({ name: "Other", slug: "other", createdAt: now })
        .returning();
      const [assigned] = await db
        .insert(projects)
        .values({ name: "Explicit tenant", origins: [origin], organizationId: other.id })
        .returning();
      for (let tick = 0; tick < 2; tick++) {
        const at = new Date(now.getTime() + tick * TICK_MS);
        await enqueueSchedules(pool, at);
        assert.equal(
          await runNextJob(pool, "legacy_projects", backfillLegacyProjects, {
            now: () => at,
            log: () => {},
          }),
          true,
        );
        const legacyProjects = await db
          .select()
          .from(projects)
          .where(eq(projects.organizationId, LEGACY_ORGANIZATION_ID));
        assert.equal(legacyProjects.length, projectIds.length);
        const [untouched] = await db.select().from(projects).where(eq(projects.id, assigned.id));
        assert.equal(untouched.organizationId, other.id);
        const failed = await pool.query(
          "select id from jobs where kind = 'legacy_projects' and (finished_at is null or last_error is not null)",
        );
        assert.equal(failed.rows.length, 0);
      }
    },
  );

  await t.test("project context is capped at 4,000 characters by the database", async () => {
    await db
      .update(projects)
      .set({ agentContext: "🙂".repeat(4000) })
      .where(eq(projects.id, projectIds[0]));
    await assert.rejects(
      db
        .update(projects)
        .set({ agentContext: "a".repeat(4001) })
        .where(eq(projects.id, projectIds[0])),
    );
  });

  await t.test(
    "M1 NULL-project reads, usage and deletion remain covered at the expand boundary",
    async () => {
      const [legacyOrg] = await db
        .select()
        .from(organization)
        .where(eq(organization.id, LEGACY_ORGANIZATION_ID));
      const [actor] = await db
        .insert(user)
        .values({
          name: "Expand owner",
          email: `expand-${randomUUID()}@example.com`,
          emailVerified: true,
        })
        .returning();
      try {
        await db.insert(member).values({
          organizationId: LEGACY_ORGANIZATION_ID,
          userId: actor.id,
          role: "owner",
          createdAt: new Date(),
        });
        const [project] = await oldDb
          .insert(legacy.projects)
          .values({ name: "Late rollback write", origins: [origin] })
          .returning();
        const period = new Date().toISOString().slice(0, 7);
        const [before] = await db
          .select()
          .from(usagePeriods)
          .where(
            and(
              eq(usagePeriods.organizationId, LEGACY_ORGANIZATION_ID),
              eq(usagePeriods.period, period),
            ),
          );
        const message = () =>
          messageSchema.parse({
            id: randomUUID(),
            type: "pageview",
            path: "/legacy",
            visitorId: randomUUID(),
            visitId: randomUUID(),
          });
        await ingest(project.id, [message()], "browser", {
          origin,
          userAgent: "Mozilla/5.0 Chrome/130.0.0.0",
        });
        await ingest(project.id, [message()], "server");
        const [usage] = await db
          .select()
          .from(usagePeriods)
          .where(
            and(
              eq(usagePeriods.organizationId, LEGACY_ORGANIZATION_ID),
              eq(usagePeriods.period, period),
            ),
          );
        assert.equal(usage.events, (before?.events ?? 0) + 2);
        const { resolveProject } = await import("../../src/server/tenancy");
        assert.equal(
          (await resolveProject(legacyOrg.slug, project.id, actor)).project.organizationId,
          null,
        );
        const { deleteOrganization } = await import("../../src/server/organizations");
        const other = await db.select().from(projects).where(eq(projects.name, "Explicit tenant"));
        await getDb().transaction((tx) => deleteOrganization(tx, LEGACY_ORGANIZATION_ID));
        assert.equal(
          (await db.select().from(projects).where(eq(projects.id, project.id))).length,
          0,
        );
        assert.equal(
          (await db.select().from(legacy.events).where(eq(legacy.events.projectId, project.id)))
            .length,
          0,
        );
        assert.equal(
          (await db.select().from(legacy.visits).where(eq(legacy.visits.projectId, project.id)))
            .length,
          0,
        );
        assert.deepEqual(await db.select().from(projects), other);
      } finally {
        await db.delete(user).where(eq(user.id, actor.id));
        await db.insert(organization).values(legacyOrg).onConflictDoNothing();
      }
    },
  );
});

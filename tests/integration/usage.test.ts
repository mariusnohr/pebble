import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { prepareContractDatabase } from "./fixtures/contract-schema";
import { getDb, closeDb } from "../../src/db";
import { apiKeys, events, organization, projects, usagePeriods, visits } from "../../src/db/schema";
import { messageSchema } from "../../src/lib/contracts";
import { hashToken } from "../../src/server/crypto";
import { ingest } from "../../src/server/ingestion";
import { cleanupRetention } from "../../src/server/jobs/cleanup";
import { POST as browserPost } from "../../src/app/api/v1/collect/route";
import { POST as serverPost } from "../../src/app/api/v1/events/route";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.startsWith("/pebble_test"))
  throw new Error(
    "Set TEST_DATABASE_URL to a dedicated database whose name starts with pebble_test.",
  );
process.env.DATABASE_URL = testUrl;
process.env.BETTER_AUTH_SECRET = randomUUID();
const organizationIds: string[] = [];
const projectIds: string[] = [];
const origin = "https://usage.example";
const context = { origin, userAgent: "Mozilla/5.0 Chrome/130.0.0.0" };
const period = () => new Date().toISOString().slice(0, 7);
const message = () =>
  messageSchema.parse({
    id: randomUUID(),
    type: "pageview",
    path: "/usage",
    visitorId: randomUUID(),
    visitId: randomUUID(),
  });

before(async () => {
  await prepareContractDatabase(getDb().$client);
});
afterEach(async () => {
  if (projectIds.length)
    await getDb()
      .delete(projects)
      .where(inArray(projects.id, projectIds.splice(0)));
  if (organizationIds.length)
    await getDb()
      .delete(organization)
      .where(inArray(organization.id, organizationIds.splice(0)));
});
after(closeDb);

async function addOrganization() {
  const [org] = await getDb()
    .insert(organization)
    .values({
      name: "Usage test",
      slug: `usage-${randomUUID()}`,
      createdAt: new Date(),
    })
    .returning();
  organizationIds.push(org.id);
  return org.id;
}

async function addProject(organizationId: string) {
  const [project] = await getDb()
    .insert(projects)
    .values({
      name: "Usage test",
      organizationId,
      origins: [origin],
      retentionDays: 7,
    })
    .returning();
  projectIds.push(project.id);
  return project.id;
}

async function usage(organizationId: string, month = period()) {
  const [row] = await getDb()
    .select()
    .from(usagePeriods)
    .where(and(eq(usagePeriods.organizationId, organizationId), eq(usagePeriods.period, month)));
  return row?.events ?? 0;
}

test("HTTP response counts match usage for browser and server pageviews and custom events", async () => {
  const org = await addOrganization();
  const project = await addProject(org);
  const page = message();
  const response = await browserPost(
    new Request("http://localhost/api/v1/collect", {
      method: "POST",
      headers: { origin, "user-agent": context.userAgent },
      body: JSON.stringify({
        projectId: project,
        events: [
          page,
          message(),
          { ...message(), type: "event", name: "completed" },
          { ...page, id: randomUUID(), type: "heartbeat" },
          page,
        ],
      }),
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: 4, duplicates: 1, ignored: 0 });
  assert.equal(await usage(org), 3);

  const token = `pb_${randomBytes(32).toString("base64url")}`;
  await getDb()
    .insert(apiKeys)
    .values({
      projectId: project,
      name: "Usage test",
      prefix: token.slice(0, 11),
      tokenHash: hashToken(token),
    });
  const serverResponse = await serverPost(
    new Request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        events: [
          message(),
          message(),
          { id: randomUUID(), type: "event", name: "job_finished" },
          page,
        ],
      }),
    }),
  );
  assert.equal(serverResponse.status, 200);
  assert.deepEqual(await serverResponse.json(), { accepted: 3, duplicates: 1, ignored: 0 });
  assert.equal(await usage(org), 6);
  const [row] = await getDb()
    .select()
    .from(usagePeriods)
    .where(eq(usagePeriods.organizationId, org));
  assert.equal(row.droppedEvents, 0);
  assert.equal(row.aiCredits, 0);
  assert.equal(row.warned80At, null);
  assert.equal(row.warned100At, null);
  assert.equal(row.stoppedAt, null);
});

test("duplicate-only, heartbeat-only and crawler batches leave usage unchanged", async () => {
  const org = await addOrganization();
  const project = await addProject(org);
  const page = message();
  await ingest(project, [page], "browser", context);
  assert.deepEqual(await ingest(project, [page, page], "browser", context), {
    accepted: 0,
    duplicates: 2,
    ignored: 0,
  });
  assert.deepEqual(
    await ingest(project, [{ ...page, id: randomUUID(), type: "heartbeat" }], "browser", context),
    {
      accepted: 1,
      duplicates: 0,
      ignored: 0,
    },
  );
  assert.deepEqual(
    await ingest(project, [message(), message()], "browser", {
      origin,
      userAgent: "Googlebot",
    }),
    { accepted: 0, duplicates: 0, ignored: 2 },
  );
  assert.equal(await usage(org), 1);
  assert.equal(
    (await getDb().select().from(events).where(eq(events.projectId, project))).length,
    1,
  );
  assert.equal(
    (await getDb().select().from(visits).where(eq(visits.projectId, project))).length,
    1,
  );
});

test("rejected batches and visitor conflicts roll back events, visits and usage together", async () => {
  const org = await addOrganization();
  const project = await addProject(org);
  const page = message();
  await ingest(project, [page], "browser", context);
  await assert.rejects(
    ingest(project, [message()], "browser", { origin: "https://wrong.example" }),
    { code: "forbidden_origin" },
  );
  await getDb().update(projects).set({ paused: true }).where(eq(projects.id, project));
  await assert.rejects(ingest(project, [message()], "browser", context), {
    code: "project_paused",
  });
  await getDb().update(projects).set({ paused: false }).where(eq(projects.id, project));
  await assert.rejects(
    ingest(
      project,
      [
        message(),
        {
          ...page,
          id: randomUUID(),
          visitorId: randomUUID(),
        },
      ],
      "browser",
      context,
    ),
    { code: "invalid_payload" },
  );
  assert.equal(await usage(org), 1);
  assert.equal(
    (await getDb().select().from(events).where(eq(events.projectId, project))).length,
    1,
  );
  assert.equal(
    (await getDb().select().from(visits).where(eq(visits.projectId, project))).length,
    1,
  );
});

test("a failed final usage update rolls back the batch's events and visits", async () => {
  const org = await addOrganization();
  const project = await addProject(org);
  // Force a real PostgreSQL error in the counter statement, after event/visit writes.
  await getDb()
    .insert(usagePeriods)
    .values({
      organizationId: org,
      period: period(),
      events: sql`9223372036854775807::bigint`,
    });
  await assert.rejects(ingest(project, [message()], "browser", context));
  assert.equal(
    (await getDb().select().from(events).where(eq(events.projectId, project))).length,
    0,
  );
  assert.equal(
    (await getDb().select().from(visits).where(eq(visits.projectId, project))).length,
    0,
  );
  const [row] = await getDb()
    .select({ value: sql<string>`${usagePeriods.events}::text` })
    .from(usagePeriods)
    .where(eq(usagePeriods.organizationId, org));
  assert.equal(row.value, "9223372036854775807");
});

test("20 concurrent batches across projects increment their organization's counter exactly", async () => {
  const org = await addOrganization();
  const first = await addProject(org);
  const second = await addProject(org);
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => {
      const page = message();
      return ingest(
        i % 2 ? first : second,
        [page, { ...message(), type: "event", name: "completed" }, page],
        i % 2 ? "browser" : "server",
        context,
      );
    }),
  );
  assert.equal(
    results.reduce((sum, result) => sum + result.accepted, 0),
    40,
  );
  assert.equal(
    results.reduce((sum, result) => sum + result.duplicates, 0),
    20,
  );
  const stored = await getDb()
    .select()
    .from(events)
    .where(inArray(events.projectId, [first, second]));
  assert.equal(stored.length, 40);
  assert.equal(await usage(org), stored.length);

  // Also exercise concurrent duplicate inserts against an already-existing counter.
  const retry = message();
  const retries = await Promise.all(
    Array.from({ length: 20 }, () => ingest(first, [retry], "browser", context)),
  );
  assert.equal(
    retries.reduce((sum, result) => sum + result.accepted, 0),
    1,
  );
  assert.equal(
    retries.reduce((sum, result) => sum + result.duplicates, 0),
    19,
  );
  assert.equal(await usage(org), 41);
  const otherOrg = await addOrganization();
  const otherProject = await addProject(otherOrg);
  await ingest(otherProject, [message()], "server");
  assert.equal(await usage(otherOrg), 1);
  assert.equal(await usage(org), 41);
});

test("usage uses the UTC receipt month rather than the event timestamp", async (t) => {
  const org = await addOrganization();
  const project = await addProject(org);
  // The UTC month differs from the local-offset month and the backdated event's month.
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-03-31T23:30:00-02:00") });
  await ingest(project, [{ ...message(), timestamp: "2026-03-31T12:00:00Z" }], "server");
  assert.equal(await usage(org, "2026-04"), 1);
  assert.equal(await usage(org, "2026-03"), 0);
  t.mock.timers.setTime(new Date("2026-05-01T00:00:00Z").getTime());
  await ingest(project, [message()], "server");
  assert.equal(await usage(org, "2026-05"), 1);
  assert.equal(await usage(org, "2026-04"), 1);
});

test("retention cleanup and project deletion never lower recorded usage", async () => {
  const org = await addOrganization();
  const project = await addProject(org);
  await ingest(project, [message(), message()], "browser", context);
  const old = new Date(Date.now() - 8 * 86400000);
  await getDb().update(events).set({ occurredAt: old }).where(eq(events.projectId, project));
  await getDb()
    .update(visits)
    .set({ startedAt: old, lastSeenAt: old, browserSeenAt: old })
    .where(eq(visits.projectId, project));
  await cleanupRetention(getDb().$client);
  assert.equal(
    (await getDb().select().from(events).where(eq(events.projectId, project))).length,
    0,
  );
  assert.equal(
    (await getDb().select().from(visits).where(eq(visits.projectId, project))).length,
    0,
  );
  assert.equal(await usage(org), 2);
  await ingest(project, [message()], "server");
  await getDb().delete(projects).where(eq(projects.id, project));
  assert.equal(
    (await getDb().select().from(events).where(eq(events.projectId, project))).length,
    0,
  );
  assert.equal(await usage(org), 3);
});

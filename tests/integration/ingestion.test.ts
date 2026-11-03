import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getDb, closeDb } from "../../src/db";
import { projects, events, visits, apiKeys } from "../../src/db/schema";
import { ingest } from "../../src/server/ingestion";
import { messageSchema } from "../../src/lib/contracts";
import { hashToken } from "../../src/server/crypto";
import { POST as serverPost } from "../../src/app/api/v1/events/route";
import { POST as browserPost } from "../../src/app/api/v1/collect/route";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.startsWith("/pebble_test"))
  throw new Error(
    "Set TEST_DATABASE_URL to a dedicated database whose name starts with pebble_test.",
  );
process.env.DATABASE_URL = testUrl;
const a = randomUUID(),
  b = randomUUID();
const origin = "https://website.example";
const context = { origin, userAgent: "Mozilla/5.0 (Macintosh) Chrome/130.0.0.0 Safari/537.36" };
const message = () =>
  messageSchema.parse({
    id: randomUUID(),
    type: "pageview",
    path: "/hello?secret=removed",
    visitorId: randomUUID(),
    visitId: randomUUID(),
    referrer: "https://search.example/?secret=removed",
    language: "en",
  });

before(async () => {
  await migrate(getDb(), { migrationsFolder: "drizzle" });
  await getDb()
    .insert(projects)
    .values([
      { id: a, name: "Integration A", origins: [origin] },
      { id: b, name: "Integration B", origins: [origin] },
    ]);
});
after(async () => {
  await getDb()
    .delete(projects)
    .where(inArray(projects.id, [a, b]));
  await closeDb();
});

test("concurrent retries store exactly one event and one visit", async () => {
  const m = message();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => ingest(a, [m], "browser", context)),
  );
  assert.equal(
    results.reduce((n, r) => n + r.accepted, 0),
    1,
  );
  assert.equal(
    results.reduce((n, r) => n + r.duplicates, 0),
    7,
  );
  const rows = await getDb()
    .select()
    .from(events)
    .where(and(eq(events.projectId, a), eq(events.id, m.id)));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, "/hello");
  const [visit] = await getDb()
    .select()
    .from(visits)
    .where(and(eq(visits.projectId, a), eq(visits.id, m.visitId!)));
  assert.equal(visit.referrer, "search.example");
  assert.ok(visit.browserSeenAt);
});
test("project isolation includes the same event and visit identifiers", async () => {
  const m = message();
  await ingest(a, [m], "browser", context);
  await ingest(b, [m], "browser", context);
  assert.equal((await getDb().select().from(events).where(eq(events.id, m.id))).length, 2);
  await assert.rejects(
    ingest(a, [message()], "browser", { origin: "https://evil.example" }),
    /Origin/,
  );
});
test("server events never manufacture online visitors or server device metadata", async () => {
  const m = messageSchema.parse({ ...message(), type: "event", name: "completed" });
  await ingest(a, [m], "server");
  const [visit] = await getDb()
    .select()
    .from(visits)
    .where(and(eq(visits.projectId, a), eq(visits.id, m.visitId!)));
  assert.equal(visit.browserSeenAt, null);
  assert.equal(visit.browser, null);
  const job = messageSchema.parse({ id: randomUUID(), type: "event", name: "job_finished" });
  await ingest(a, [job], "server");
  const [event] = await getDb()
    .select()
    .from(events)
    .where(and(eq(events.projectId, a), eq(events.id, job.id)));
  assert.equal(event.visitorId, null);
  assert.equal(event.visitId, null);
  await assert.rejects(
    ingest(a, [messageSchema.parse({ ...m, type: "heartbeat", name: undefined })], "server"),
    /browser-only/,
  );
});
test("heartbeats update presence without creating event rows", async () => {
  const m = message();
  await ingest(a, [m], "browser", context);
  const heartbeat = messageSchema.parse({
    ...m,
    id: randomUUID(),
    type: "heartbeat",
    path: "/next",
  });
  await ingest(a, [heartbeat], "browser", context);
  const [visit] = await getDb()
    .select()
    .from(visits)
    .where(and(eq(visits.projectId, a), eq(visits.id, m.visitId!)));
  assert.equal(visit.currentPath, "/next");
  assert.equal((await getDb().select().from(events).where(eq(events.id, heartbeat.id))).length, 0);
});
test("browser attribution is preserved when a linked server outcome arrives first", async () => {
  const page = message();
  const outcome = messageSchema.parse({
    ...page,
    id: randomUUID(),
    type: "event",
    name: "completed",
    path: undefined,
    referrer: undefined,
    language: undefined,
  });
  await ingest(a, [outcome], "server");
  await ingest(a, [{ ...page, utm: { source: "newsletter" } }], "browser", context);
  await ingest(
    a,
    [
      {
        ...page,
        id: randomUUID(),
        path: "/second",
        utm: { source: "later" },
        referrer: "https://later.example",
      },
    ],
    "browser",
    context,
  );
  const [visit] = await getDb()
    .select()
    .from(visits)
    .where(and(eq(visits.projectId, a), eq(visits.id, page.visitId!)));
  assert.equal(visit.entryPath, "/hello");
  assert.equal(visit.currentPath, "/second");
  assert.equal(visit.referrer, "search.example");
  assert.equal(visit.utmSource, "newsletter");
  assert.equal(visit.browser, "Chrome");
});
test("conflicting visitor identity rolls back the entire batch", async () => {
  const m = message();
  await ingest(a, [m], "browser", context);
  const valid = message(),
    invalid = messageSchema.parse({ ...m, id: randomUUID(), visitorId: randomUUID() });
  await assert.rejects(ingest(a, [valid, invalid], "browser", context), /different visitor/);
  assert.equal(
    (
      await getDb()
        .select()
        .from(events)
        .where(inArray(events.id, [valid.id, invalid.id]))
    ).length,
    0,
  );
});
test("HTTP endpoint enforces server key scope, revocation, and browser origin", async () => {
  const token = `pb_${Buffer.alloc(32, 1).toString("base64url")}`;
  const [key] = await getDb()
    .insert(apiKeys)
    .values({ projectId: a, name: "Test", prefix: token.slice(0, 11), tokenHash: hashToken(token) })
    .returning();
  const request = (projectId?: string) =>
    new Request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        projectId,
        events: [{ id: randomUUID(), type: "event", name: "test" }],
      }),
    });
  assert.equal((await serverPost(request(b))).status, 403);
  assert.equal((await serverPost(request())).status, 200);
  await getDb().update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, key.id));
  assert.equal((await serverPost(request())).status, 401);
  const response = await browserPost(
    new Request("http://localhost/api/v1/collect", {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: JSON.stringify({ projectId: a, events: [message()] }),
    }),
  );
  assert.equal(response.status, 403);
});
test("paused and deleted projects stop ingestion; deletion removes dependent data", async () => {
  const [project] = await getDb()
    .insert(projects)
    .values({ name: "Disposable", origins: [origin] })
    .returning();
  await ingest(project.id, [message()], "browser", context);
  await getDb()
    .insert(apiKeys)
    .values({ projectId: project.id, name: "Disposable", prefix: "pb_x", tokenHash: randomUUID() });
  await getDb().update(projects).set({ paused: true }).where(eq(projects.id, project.id));
  await assert.rejects(ingest(project.id, [message()], "browser", context), /paused/);
  await getDb().delete(projects).where(eq(projects.id, project.id));
  assert.equal(
    (await getDb().select().from(events).where(eq(events.projectId, project.id))).length,
    0,
  );
  assert.equal(
    (await getDb().select().from(visits).where(eq(visits.projectId, project.id))).length,
    0,
  );
  assert.equal(
    (await getDb().select().from(apiKeys).where(eq(apiKeys.projectId, project.id))).length,
    0,
  );
  await assert.rejects(ingest(project.id, [message()], "browser", context), /not found/);
});

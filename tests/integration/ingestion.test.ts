import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getDb, closeDb } from "../../src/db";
import { projects, events, visits, apiKeys, rateLimits } from "../../src/db/schema";
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
process.env.TRUST_PROXY = "true";
// Isolate this suite's rate-limit buckets from other suites and previous runs.
process.env.BETTER_AUTH_SECRET = randomUUID();
const bucketKeys = new Set<string>();
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

function browserRequest(
  payload: unknown,
  options: { origin?: string | null; address?: string } = {},
) {
  return new Request("http://localhost/api/v1/collect", {
    method: "POST",
    headers: {
      ...(options.origin === null ? {} : { origin: options.origin ?? origin }),
      "x-forwarded-for": options.address ?? "192.0.2.100",
      "user-agent": context.userAgent,
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

function serverRequest(token?: string, payload: unknown = { events: [message()] }) {
  return new Request("http://localhost/api/v1/events", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

async function addKey() {
  const token = `pb_${randomBytes(32).toString("base64url")}`;
  const [key] = await getDb()
    .insert(apiKeys)
    .values({
      projectId: a,
      name: "Independent key",
      prefix: token.slice(0, 11),
      tokenHash: hashToken(token),
    })
    .returning();
  return { ...key, token };
}

async function assertError(response: Response, status: number, error: string, code: string) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { error, code });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  if (status === 429) assert.equal(response.headers.get("Retry-After"), "60");
}

async function seedRateLimit(key: string, count: number) {
  const bucket = Math.floor(Date.now() / 60000);
  const hashed = hashToken(`${process.env.BETTER_AUTH_SECRET}:${key}:${bucket}`);
  bucketKeys.add(hashed);
  await getDb()
    .insert(rateLimits)
    .values({
      key: hashed,
      count,
      expiresAt: new Date((bucket + 1) * 60000),
    })
    .onConflictDoUpdate({ target: rateLimits.key, set: { count } });
}

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
  if (bucketKeys.size)
    await getDb()
      .delete(rateLimits)
      .where(inArray(rateLimits.key, [...bucketKeys]));
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
  await assertError(
    await serverPost(request(b)),
    403,
    "API key belongs to another project.",
    "unauthorized",
  );
  assert.equal((await serverPost(request())).status, 200);
  await getDb().update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, key.id));
  await assertError(
    await serverPost(request()),
    401,
    "Invalid or revoked API key.",
    "unauthorized",
  );
  const response = await browserPost(
    new Request("http://localhost/api/v1/collect", {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: JSON.stringify({ projectId: a, events: [message()] }),
    }),
  );
  await assertError(response, 403, "Origin is not allowed for this project.", "forbidden_origin");
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

test("HTTP errors preserve messages, codes, and payload/project/origin/paused check order", async () => {
  const unknown = randomUUID();
  const valid = { projectId: a, events: [message()] };
  const beforeEvents = await getDb().select().from(events).where(eq(events.projectId, a));
  const beforeVisits = await getDb().select().from(visits).where(eq(visits.projectId, a));
  await getDb().update(projects).set({ paused: true }).where(eq(projects.id, a));
  try {
    for (const [payload, requestOrigin, status, error, code] of [
      ["{", null, 400, "Invalid JSON body.", "invalid_payload"],
      [
        { projectId: unknown, events: [] },
        null,
        400,
        "Invalid tracking payload.",
        "invalid_payload",
      ],
      [
        { projectId: unknown, events: [message()] },
        null,
        404,
        "Project not found.",
        "project_not_found",
      ],
      [
        { projectId: unknown, events: [message()] },
        "https://evil.example",
        404,
        "Project not found.",
        "project_not_found",
      ],
      [valid, null, 403, "A website origin is required.", "forbidden_origin"],
      [valid, "null", 403, "A website origin is required.", "forbidden_origin"],
      [
        valid,
        "https://evil.example",
        403,
        "Origin is not allowed for this project.",
        "forbidden_origin",
      ],
      [valid, origin, 403, "Collection is paused.", "project_paused"],
      [" ".repeat(32769), null, 413, "Payload too large.", "payload_too_large"],
      [
        { projectId: a, events: [{ id: randomUUID(), type: "pageview", path: "/" }] },
        origin,
        400,
        "Browser messages require visitor and visit identifiers.",
        "invalid_payload",
      ],
      [
        { projectId: a, events: [{ ...message(), timestamp: "2000-01-01T00:00:00Z" }] },
        origin,
        400,
        "Timestamp must be within the last 7 days and no more than 5 minutes ahead.",
        "invalid_payload",
      ],
    ] as const) {
      const response = await browserPost(browserRequest(payload, { origin: requestOrigin }));
      await assertError(response, status, error, code);
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), requestOrigin ?? "null");
    }
    const key = await addKey();
    await assertError(
      await serverPost(serverRequest()),
      401,
      "A valid project API key is required.",
      "unauthorized",
    );
    await assertError(
      await serverPost(serverRequest("pb_invalid")),
      401,
      "A valid project API key is required.",
      "unauthorized",
    );
    await assertError(
      await serverPost(serverRequest(`pb_${randomBytes(32).toString("base64url")}`)),
      401,
      "Invalid or revoked API key.",
      "unauthorized",
    );
    await assertError(
      await serverPost(serverRequest(key.token, "{")),
      400,
      "Invalid JSON body.",
      "invalid_payload",
    );
    await assertError(
      await serverPost(serverRequest(key.token, { events: [] })),
      400,
      "Invalid tracking payload.",
      "invalid_payload",
    );
    await assertError(
      await serverPost(serverRequest(key.token, " ".repeat(32769))),
      413,
      "Payload too large.",
      "payload_too_large",
    );
    await assertError(
      await serverPost(serverRequest(key.token, { events: [{ ...message(), type: "heartbeat" }] })),
      400,
      "Heartbeats are browser-only.",
      "invalid_payload",
    );
    await assertError(
      await serverPost(serverRequest(key.token)),
      403,
      "Collection is paused.",
      "project_paused",
    );
    assert.deepEqual(
      await getDb().select().from(events).where(eq(events.projectId, a)),
      beforeEvents,
    );
    assert.deepEqual(
      await getDb().select().from(visits).where(eq(visits.projectId, a)),
      beforeVisits,
    );
  } finally {
    await getDb().update(projects).set({ paused: false }).where(eq(projects.id, a));
  }
});

test("collect accepts 600 requests per IP and keeps different last forwarded IPs independent", async (t) => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const payload = { projectId: a, events: [message()] };
  await seedRateLimit("collect:192.0.2.1", 0);
  await seedRateLimit("collect:192.0.2.2", 0);
  for (let i = 0; i < 600; i++) {
    const response = await browserPost(
      browserRequest(payload, { address: "198.51.100.1, 192.0.2.1" }),
    );
    assert.equal(response.status, 200, `Request ${i + 1}`);
    assert.deepEqual(await response.json(), {
      accepted: i === 0 ? 1 : 0,
      duplicates: i === 0 ? 0 : 1,
      ignored: 0,
    });
  }
  await assertError(
    await browserPost(browserRequest(payload, { address: "198.51.100.2, 192.0.2.1" })),
    429,
    "Rate limit exceeded.",
    "rate_limited",
  );
  // The IP check wins even when both JSON and origin are invalid.
  await assertError(
    await browserPost(browserRequest("{", { address: "198.51.100.3, 192.0.2.1", origin: null })),
    429,
    "Rate limit exceeded.",
    "rate_limited",
  );
  const response = await browserPost(
    browserRequest(
      { projectId: a, events: [message()] },
      {
        address: "198.51.100.1, 192.0.2.2",
      },
    ),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: 1, duplicates: 0, ignored: 0 });
});

test("collect enforces 6000 per project before message validation across client IPs", async (t) => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  await seedRateLimit(`project:${a}`, 5999);
  try {
    const response = await browserPost(browserRequest({ projectId: a, events: [message()] }));
    assert.equal(response.status, 200);
    for (const address of ["192.0.2.3", "192.0.2.4"])
      await assertError(
        await browserPost(browserRequest({ projectId: a, events: [] }, { address, origin: null })),
        429,
        "Project rate limit exceeded.",
        "rate_limited",
      );
    assert.equal(
      (await browserPost(browserRequest({ projectId: b, events: [message()] }))).status,
      200,
    );
  } finally {
    await seedRateLimit(`project:${a}`, 0);
  }
});

test("two server keys of one project have independent 6000-request limits", async (t) => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const first = await addKey();
  const second = await addKey();
  await seedRateLimit(`server:${first.id}`, 5999);
  const response = await serverPost(serverRequest(first.token));
  assert.equal(response.status, 200);
  await assertError(
    await serverPost(serverRequest(first.token)),
    429,
    "Rate limit exceeded.",
    "rate_limited",
  );
  await assertError(
    await serverPost(serverRequest(first.token, "{")),
    429,
    "Rate limit exceeded.",
    "rate_limited",
  );
  const independent = await serverPost(serverRequest(second.token));
  assert.equal(independent.status, 200);
  assert.deepEqual(await independent.json(), { accepted: 1, duplicates: 0, ignored: 0 });
});

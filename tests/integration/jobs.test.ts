import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { LEGACY_ORGANIZATION_ID } from "../../src/server/legacy-organization";
import { prepareContractDatabase } from "./fixtures/contract-schema";
import { getDb, closeDb } from "../../src/db";
import { emailOutbox } from "../../src/db/schema";
import { queueEmail } from "../../src/server/email/queue";
import {
  sendOutbox,
  warnIfEmailUnconfigured,
  type SenderOptions,
} from "../../src/server/email/sender";
import { cleanupRetention, purgeMaintenance } from "../../src/server/jobs/cleanup";
import {
  claimJob,
  enqueueSchedules,
  JOB_LEASE_MS,
  runNextJob,
  type JobKind,
} from "../../src/server/jobs/queue";
import { MAX_ATTEMPTS } from "../../src/server/jobs/retry";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.startsWith("/pebble_test"))
  throw new Error(
    "Set TEST_DATABASE_URL to a dedicated database whose name starts with pebble_test.",
  );
process.env.DATABASE_URL = testUrl;
const db = getDb();
const pool = db.$client;
const jobIds: string[] = [],
  emailIds: string[] = [],
  projectIds: string[] = [];
const bucketKeys: string[] = [];
const data = {
  subject: "Test message",
  heading: "Hello",
  paragraphs: ["Integration message"],
  organizationName: "Test organization",
  projectName: "Test project",
  links: [{ label: "Open project", path: "/projects/test?token=private-test-token" }],
};
const emailEnv = {
  RESEND_API_KEY: "mock-key",
  EMAIL_FROM: "Pebble <test@example.com>",
  APP_URL: "https://pebble.example",
};

before(async () => {
  await prepareContractDatabase(db.$client);
});
afterEach(async () => {
  await pool.query("delete from jobs where id = any($1::uuid[])", [jobIds.splice(0)]);
  await pool.query("delete from email_outbox where id = any($1::uuid[])", [emailIds.splice(0)]);
  await pool.query("delete from projects where id = any($1::uuid[])", [projectIds.splice(0)]);
  await pool.query("delete from rate_limits where key = any($1::text[])", [bucketKeys.splice(0)]);
});
after(async () => {
  await closeDb();
});

async function addJob(kind: JobKind, at = new Date()) {
  const { rows } = await pool.query<{ id: string }>(
    "insert into jobs (kind, unique_key, run_at) values ($1, $2, $3) returning id",
    [kind, `test:${randomUUID()}`, at],
  );
  jobIds.push(rows[0].id);
  return rows[0].id;
}
async function queuedEmail() {
  const id = await db.transaction((tx) =>
    queueEmail(tx, { to: "recipient@example.com", template: "message", data }),
  );
  emailIds.push(id);
  return id;
}
async function emailState(id: string) {
  return (await db.select().from(emailOutbox).where(eq(emailOutbox.id, id)))[0];
}
async function send(options: SenderOptions) {
  const client = await pool.connect();
  try {
    await sendOutbox(client, options);
  } finally {
    client.release();
  }
}

test("schedules use unique keys across overlapping deployments", async () => {
  const now = new Date();
  await Promise.all(Array.from({ length: 4 }, () => enqueueSchedules(pool, now)));
  const { rows } = await pool.query<{ id: string; unique_key: string }>(
    "select id, unique_key from jobs",
  );
  jobIds.push(...rows.map((row) => row.id));
  assert.equal(rows.length, 6);
  assert.equal(new Set(rows.map((row) => row.unique_key)).size, 6);
});

test("lease expiry recovers an interrupted claim, and retries back off and stop", async () => {
  let now = new Date();
  const id = await addJob("retention", now);
  const client = await pool.connect();
  assert.equal((await claimJob(client, "retention", now))!.attempts, 1);
  client.release(true); // Lost process: its persisted lease remains, its connection does not.
  const lines: string[] = [];
  const options = { now: () => now, log: (line: string) => lines.push(line) };
  const fail = async () => {
    throw new Error("payload-must-not-be-logged");
  };
  assert.equal(await runNextJob(pool, "retention", fail, options), false);
  now = new Date(now.getTime() + JOB_LEASE_MS + 1);
  for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
    assert.equal(await runNextJob(pool, "retention", fail, options), true);
    const row = (await pool.query("select * from jobs where id = $1", [id])).rows[0];
    assert.equal(row.attempts, attempt);
    assert.equal(row.last_error, "execution_failed");
    if (attempt < MAX_ATTEMPTS) {
      assert.equal(row.finished_at, null);
      assert.ok(row.run_at > now);
      assert.equal(await runNextJob(pool, "retention", fail, options), false);
      now = row.run_at;
    } else assert.ok(row.finished_at);
  }
  assert.equal(await runNextJob(pool, "retention", fail, options), false);
  assert.equal(lines.length, 5);
  assert.ok(
    lines.every(
      (line) =>
        JSON.parse(line).kind === "retention" && typeof JSON.parse(line).duration_ms === "number",
    ),
  );
  assert.equal(JSON.parse(lines.at(-1)!).outcome, "failed");
  assert.ok(!lines.join("").includes("payload-must-not-be-logged"));
});

test("an active worker excludes a second job of its kind even when its lease expires", async () => {
  const now = new Date();
  const id = await addJob("retention", now);
  await addJob("retention", new Date(now.getTime() + 1));
  const purgeId = await addJob("purge", now);
  let entered!: () => void, finish!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const finishedPromise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const options = { now: () => new Date(now.getTime() + JOB_LEASE_MS + 10), log: () => {} };
  const running = runNextJob(
    pool,
    "retention",
    async () => {
      entered();
      await finishedPromise;
    },
    { log: () => {} },
  );
  await enteredPromise;
  try {
    await pool.query("update jobs set locked_until = $2 where id = $1", [id, now]);
    assert.equal(
      await runNextJob(pool, "retention", async () => assert.fail("duplicate worker"), options),
      false,
    );
    assert.equal(await runNextJob(pool, "purge", async () => {}, options), true);
    assert.ok(
      (await pool.query("select finished_at from jobs where id = $1", [purgeId])).rows[0]
        .finished_at,
    );
  } finally {
    finish();
    await running;
  }
});

test("an expired lease after the last crash is finalized instead of retrying forever", async () => {
  const id = await addJob("retention");
  await pool.query(
    "update jobs set attempts = $2, locked_until = now() - interval '1 minute' where id = $1",
    [id, MAX_ATTEMPTS],
  );
  assert.equal(await runNextJob(pool, "retention", async () => assert.fail("exhausted")), false);
  const row = (await pool.query("select * from jobs where id = $1", [id])).rows[0];
  assert.ok(row.finished_at);
  assert.equal(row.last_error, "attempts_exhausted");
});

test("queueEmail participates in its caller's transaction", async () => {
  let id = "";
  await assert.rejects(
    db.transaction(async (tx) => {
      id = await queueEmail(tx, { to: "recipient@example.com", template: "message", data });
      throw new Error("rollback");
    }),
    /rollback/,
  );
  assert.equal(await emailState(id), undefined);
});

test("a crash after provider acceptance recovers the job and delivers exactly once", async () => {
  const id = await queuedEmail();
  let now = new Date(Date.now() + 1000);
  const jobId = await addJob("outbox", now);
  const client = await pool.connect();
  await claimJob(client, "outbox", now);
  const deliveries = new Set<string>();
  const keys: string[] = [];
  let crashed = false;
  const mockFetch: typeof fetch = async (_url, init) => {
    const key = new Headers(init!.headers).get("Idempotency-Key")!;
    keys.push(key);
    deliveries.add(key);
    if (!crashed) {
      crashed = true;
      client.release(true);
    }
    return Response.json({ id: "provider-once" });
  };
  const options = { env: emailEnv, now: () => now, fetch: mockFetch, log: () => {} };
  await assert.rejects(sendOutbox(client, options)); // Cannot commit sent_at after the connection dies.
  assert.equal((await emailState(id)).status, "queued");
  now = new Date(now.getTime() + JOB_LEASE_MS + 1);
  assert.equal(
    await runNextJob(pool, "outbox", (connection) => sendOutbox(connection, options), {
      now: () => now,
      log: () => {},
    }),
    true,
  );
  assert.deepEqual(keys, [id, id]);
  assert.equal(deliveries.size, 1);
  const row = await emailState(id);
  assert.equal(row.status, "sent");
  assert.equal(row.attempts, 2);
  assert.equal(row.providerId, "provider-once");
  assert.ok(
    (await pool.query("select finished_at from jobs where id = $1", [jobId])).rows[0].finished_at,
  );
  await send(options);
  assert.equal(keys.length, 2);
});

test("timeout after acceptance, 409 and 5xx reuse the same key and request body", async () => {
  const id = await queuedEmail();
  let now = new Date(Date.now() + 1000);
  const bodies: unknown[] = [],
    keys: string[] = [];
  const delivered = new Set<string>();
  const lines: string[] = [];
  const mockFetch: typeof fetch = async (_url, init) => {
    const key = new Headers(init!.headers).get("Idempotency-Key")!;
    keys.push(key);
    bodies.push(init!.body);
    assert.equal(new Headers(init!.headers).get("Authorization"), "Bearer mock-key");
    assert.ok(init!.signal);
    delivered.add(key);
    if (keys.length === 1) throw new DOMException("private-test-token", "TimeoutError");
    if (keys.length === 2) return new Response("private-test-token", { status: 409 });
    if (keys.length === 3) return new Response("private-test-token", { status: 503 });
    return Response.json({ id: "accepted-once" });
  };
  for (let i = 0; i < 4; i++) {
    await send({
      env: emailEnv,
      now: () => now,
      fetch: mockFetch,
      log: (line) => lines.push(line),
    });
    const row = await emailState(id);
    assert.equal(row.attempts, i + 1);
    if (i < 3) {
      assert.equal(row.status, "queued");
      now = row.nextAttemptAt;
    }
  }
  assert.equal((await emailState(id)).status, "sent");
  assert.deepEqual(keys, [id, id, id, id]);
  assert.equal(new Set(bodies).size, 1);
  assert.equal(delivered.size, 1);
  assert.equal(lines.length, 0);
});

test("missing configuration fails without exposing contents, and explicit log mode logs links", async () => {
  const id = await queuedEmail();
  const lines: string[] = [];
  warnIfEmailUnconfigured({}, (line) => lines.push(line));
  await send({
    env: {},
    log: (line) => lines.push(line),
    fetch: async () => assert.fail("no network"),
  });
  const row = await emailState(id);
  assert.equal(row.status, "failed");
  assert.equal(row.failureReason, "not_configured");
  assert.deepEqual(lines, [
    "Email is not configured",
    JSON.stringify({ template: "message", reason: "not_configured" }),
  ]);
  const loggedId = await queuedEmail();
  await send({
    env: { EMAIL_TRANSPORT: "log", APP_URL: emailEnv.APP_URL },
    log: (line) => lines.push(line),
    fetch: async () => assert.fail("no network"),
  });
  assert.deepEqual(JSON.parse(lines.at(-1)!), {
    to: "recipient@example.com",
    subject: data.subject,
    links: [`${emailEnv.APP_URL}${data.links[0].path}`],
  });
  assert.equal((await emailState(loggedId)).status, "sent");
});

test("permanent errors fail immediately; transient failures stop after five retries", async () => {
  const permanent = await queuedEmail();
  const lines: string[] = [];
  let now = new Date(Date.now() + 1000);
  await send({
    env: emailEnv,
    now: () => now,
    log: (line) => lines.push(line),
    fetch: async () => new Response("private-test-token", { status: 422 }),
  });
  assert.equal((await emailState(permanent)).failureReason, "http_422");
  const retry = await queuedEmail();
  let sends = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await send({
      env: emailEnv,
      now: () => now,
      log: (line) => lines.push(line),
      fetch: async () => {
        sends++;
        return new Response("private-test-token", { status: 503 });
      },
    });
    const row = await emailState(retry);
    if (attempt < MAX_ATTEMPTS) {
      assert.equal(row.status, "queued");
      now = row.nextAttemptAt;
    } else {
      assert.equal(row.status, "failed");
      assert.equal(row.failureReason, "http_503");
    }
  }
  assert.equal(sends, MAX_ATTEMPTS);
  assert.ok(now.getTime() - (await emailState(retry)).firstAttemptAt!.getTime() < 3_600_000);
  assert.equal(lines.length, 2);
  assert.ok(!lines.join("").includes("private-test-token"));
});

test("downtime cannot extend the email retry window past one hour", async () => {
  const id = await queuedEmail();
  await pool.query(
    "update email_outbox set attempts = 1, first_attempt_at = now() - interval '61 minutes' where id = $1",
    [id],
  );
  await send({
    env: emailEnv,
    log: () => {},
    fetch: async () => assert.fail("expired idempotency window"),
  });
  assert.equal((await emailState(id)).failureReason, "retry_window_expired");
});

test("retention job deletes in batches using each project's cutoff and visits' last activity", async () => {
  for (const retention of [7, 30]) {
    const project = randomUUID();
    projectIds.push(project);
    await pool.query(
      "insert into projects (id, name, origins, retention_days, organization_id) values ($1, 'Retention test', '{}', $2, $3)",
      [project, retention, LEGACY_ORGANIZATION_ID],
    );
    for (const days of [1, 8, 31]) {
      await pool.query(
        `insert into events (project_id, id, type, source, occurred_at)
        select $1, gen_random_uuid(), 'event', 'server', now() - ($2 * interval '1 day') from generate_series(1, 5001)`,
        [project, days],
      );
      await pool.query(
        `insert into visits (project_id, id, visitor_id, started_at, last_seen_at)
        select $1, gen_random_uuid(), gen_random_uuid(), now() - interval '40 days', now() - ($2 * interval '1 day') from generate_series(1, 5001)`,
        [project, days],
      );
    }
  }
  await addJob("retention");
  await runNextJob(pool, "retention", cleanupRetention, { log: () => {} });
  for (const [i, project] of projectIds.entries()) {
    for (const table of ["events", "visits"]) {
      assert.equal(
        Number(
          (await pool.query(`select count(*) from ${table} where project_id = $1`, [project]))
            .rows[0].count,
        ),
        i === 0 ? 5001 : 10002,
      );
    }
  }
  await cleanupRetention(pool); // Replaying committed batches is harmless.
  assert.equal(
    Number(
      (await pool.query("select count(*) from events where project_id = $1", [projectIds[0]]))
        .rows[0].count,
    ),
    5001,
  );
});

test("daily purge removes expired maintenance data but preserves recent and unfinished rows", async () => {
  for (const old of [true, false]) {
    const key = randomUUID();
    bucketKeys.push(key);
    const expiry = new Date(Date.now() + (old ? -1 : 1) * 86_400_000);
    await pool.query("insert into rate_limits (key, count, expires_at) values ($1, 1, $2)", [
      key,
      expiry,
    ]);
    const jobId = await addJob("retention");
    await pool.query(
      "update jobs set finished_at = now() - ($2 * interval '1 day') where id = $1",
      [jobId, old ? 8 : 6],
    );
    for (const status of ["queued", "sent", "failed"]) {
      const email = await queuedEmail();
      await pool.query(
        "update email_outbox set status = $2, created_at = now() - ($3 * interval '1 day') where id = $1",
        [email, status, old ? 31 : 29],
      );
    }
  }
  const unfinished = await addJob("retention", new Date("2020-01-01"));
  await purgeMaintenance(pool);
  assert.equal(
    (await pool.query("select id from jobs where id = any($1::uuid[])", [jobIds])).rows.length,
    2,
  );
  assert.equal(
    (await pool.query("select id from jobs where id = $1", [unfinished])).rows.length,
    1,
  );
  assert.equal(
    (await pool.query("select id from email_outbox where id = any($1::uuid[])", [emailIds])).rows
      .length,
    3,
  );
  assert.equal(
    (await pool.query("select key from rate_limits where key = any($1::text[])", [bucketKeys])).rows
      .length,
    1,
  );
});

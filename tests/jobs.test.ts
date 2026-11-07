import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { JOB_KINDS, scheduledJobs, TICK_MS } from "../src/server/jobs/queue";
import { renderEmail } from "../src/server/email/templates";
import { emailTransport, warnIfEmailUnconfigured } from "../src/server/email/sender";
import { register } from "../src/instrumentation";
import { startJobRunner } from "../src/server/jobs/runner";

test("daily schedules catch up after downtime and enqueue the next UTC run", () => {
  const before = scheduledJobs(new Date("2026-11-08T02:59:59Z"));
  assert.deepEqual(
    before
      .filter((job) => job.kind === "retention")
      .map((job) => [job.uniqueKey, job.runAt.toISOString()]),
    [
      ["retention:2026-11-07", "2026-11-07T03:00:00.000Z"],
      ["retention:2026-11-08", "2026-11-08T03:00:00.000Z"],
    ],
  );
  const after = scheduledJobs(new Date("2026-11-08T03:00:00Z"));
  assert.equal(after[0].uniqueKey, "retention:2026-11-08");
  assert.equal(after[1].uniqueKey, "retention:2026-11-09");
  assert.equal(
    after.find((job) => job.kind === "purge")!.runAt.toISOString(),
    "2026-11-07T03:30:00.000Z",
  );
  assert.equal(
    scheduledJobs(new Date("2026-11-08T03:00:29Z")).at(-1)!.uniqueKey,
    after.at(-1)!.uniqueKey,
  );
});

test("legacy project backfill is scheduled on boot and each runner tick", () => {
  const boot = new Date("2026-11-08T12:00:17Z");
  const at = (date: Date) => scheduledJobs(date).filter((job) => job.kind === "legacy_projects");
  assert.ok(JOB_KINDS.includes("legacy_projects"));
  assert.deepEqual(at(boot), [
    {
      kind: "legacy_projects",
      uniqueKey: "legacy_projects:2026-11-08T12:00:00.000Z",
      runAt: new Date("2026-11-08T12:00:00Z"),
    },
  ]);
  assert.notEqual(at(new Date(boot.getTime() + TICK_MS))[0].uniqueKey, at(boot)[0].uniqueKey);
});

test("plain email layout escapes content, names context, and restricts links to APP_URL", () => {
  const data = {
    subject: "A message",
    heading: "Hello <script>",
    paragraphs: ["A & B"],
    organizationName: "Acme",
    projectName: "Store",
    links: [{ label: "Open", path: "/projects/1?token=test" }],
  };
  const email = renderEmail("message", data, "https://pebble.example");
  assert.match(email.html, /Hello &lt;script&gt;/);
  assert.match(email.html, /A &amp; B/);
  assert.match(email.text, /Organization: Acme/);
  assert.match(email.text, /Project: Store/);
  assert.deepEqual(email.links, ["https://pebble.example/projects/1?token=test"]);
  assert.match(email.text, /https:\/\/pebble.example\/projects/);
  for (const path of [
    "//evil.example",
    "/\\evil.example",
    "https://evil.example",
    "javascript:alert(1)",
  ]) {
    assert.throws(() =>
      renderEmail(
        "message",
        { ...data, links: [{ label: "Open", path }] },
        "https://pebble.example",
      ),
    );
  }
  assert.throws(() => renderEmail("unknown", data, "https://pebble.example"));
  assert.throws(() => renderEmail("constructor", data, "https://pebble.example"));
});

test("log transport is explicit, overrides a key on preview, and missing config warns without content", () => {
  assert.equal(emailTransport({}), "not_configured");
  assert.equal(emailTransport({ EMAIL_TRANSPORT: "resend" }), "not_configured");
  assert.equal(emailTransport({ RESEND_API_KEY: "test-key" }), "resend");
  assert.equal(emailTransport({ EMAIL_TRANSPORT: "log", RESEND_API_KEY: "test-key" }), "log");
  const warnings: string[] = [];
  warnIfEmailUnconfigured({}, (line) => warnings.push(line));
  warnIfEmailUnconfigured({ EMAIL_TRANSPORT: "log" }, (line) => warnings.push(line));
  assert.deepEqual(warnings, ["Email is not configured"]);
});

test("instrumentation does not load the runner in builds, Edge, or without a database", async () => {
  const keys = ["NEXT_RUNTIME", "NEXT_PHASE", "DATABASE_URL"] as const;
  const saved = keys.map((key) => process.env[key]);
  try {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.NEXT_PHASE = "phase-production-build";
    process.env.DATABASE_URL = "not-a-database";
    await register();
    process.env.NEXT_RUNTIME = "edge";
    delete process.env.NEXT_PHASE;
    await register();
    process.env.NEXT_RUNTIME = "nodejs";
    delete process.env.DATABASE_URL;
    await register();
    assert.equal((globalThis as { pebbleJobRunner?: unknown }).pebbleJobRunner, undefined);
  } finally {
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    });
  }
});

test("runner startup is a singleton and warns once even when the database is unavailable", async (t) => {
  const pool = new Pool();
  // No socket is opened: startup's scheduler encounters a simulated database outage.
  t.mock.method(pool, "query", async () => {
    throw new Error("unavailable");
  });
  const warnings: string[] = [],
    logs: string[] = [];
  t.mock.method(console, "warn", (line: string) => warnings.push(line));
  t.mock.method(console, "log", (line: string) => logs.push(line));
  t.mock.method(console, "error", () => {});
  const savedKey = process.env.RESEND_API_KEY,
    savedTransport = process.env.EMAIL_TRANSPORT;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_TRANSPORT;
  const state = globalThis as { pebbleJobRunner?: ReturnType<typeof setInterval> };
  try {
    startJobRunner(pool);
    const timer = state.pebbleJobRunner;
    startJobRunner(pool);
    assert.equal(state.pebbleJobRunner, timer);
    assert.deepEqual(warnings, ["Email is not configured"]);
    assert.deepEqual(
      logs.map((line) => JSON.parse(line)),
      [{ event: "job_runner_started", interval_ms: 30_000 }],
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    clearInterval(state.pebbleJobRunner);
    delete state.pebbleJobRunner;
    if (savedKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = savedKey;
    if (savedTransport === undefined) delete process.env.EMAIL_TRANSPORT;
    else process.env.EMAIL_TRANSPORT = savedTransport;
    await pool.end();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../packages/analytics/src/server";

test("server SDK retries retain event identity and carry request-specific context", async (t) => {
  const requests: { body: string; authorization: string }[] = [];
  t.mock.method(globalThis, "fetch", async (_: unknown, init: RequestInit) => {
    requests.push({
      body: String(init.body),
      authorization: (init.headers as Record<string, string>).Authorization,
    });
    return requests.length === 1
      ? new Response(null, { status: 503 })
      : Response.json({ accepted: 1, duplicates: 0 });
  });
  const client = createClient({ endpoint: "https://analytics.example", apiKey: "pb_test" });
  const result = await client.track(
    "completed",
    { plan: "small" },
    { context: { visitorId: "visitor-a", visitId: "visit-a" } },
  );
  assert.equal(result.ok, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body, requests[1].body);
  assert.equal(requests[0].authorization, "Bearer pb_test");
  const payload = JSON.parse(requests[0].body);
  assert.equal(payload.events[0].visitorId, "visitor-a");
  await client.track("job_finished");
  assert.equal(JSON.parse(requests[2].body).events[0].visitorId, undefined);
});
test("server SDK reports rejected events without retrying or throwing", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(null, { status: 401 });
  });
  const result = await createClient({
    endpoint: "https://analytics.example",
    apiKey: "pb_revoked",
  }).track("event");
  assert.deepEqual(result, { ok: false, error: "Pebble returned 401", status: 401 });
  assert.equal(calls, 1);
});

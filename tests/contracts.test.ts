import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  cleanPath,
  envelopeSchema,
  normalizeOrigins,
  propertiesSchema,
  validTimezone,
} from "../src/lib/contracts";
import { readJson } from "../src/server/http";

test("paths drop query strings and fragments and origins are exact", () => {
  assert.equal(cleanPath("/pricing?email=private@example.com#details"), "/pricing");
  assert.throws(() => cleanPath("//other.example/path"));
  assert.deepEqual(normalizeOrigins("example.com,https://example.com\nhttp://localhost:3001"), [
    "https://example.com",
    "http://localhost:3001",
  ]);
  assert.throws(() => normalizeOrigins("https://example.com/path"));
  assert.throws(() => normalizeOrigins("https://user:password@example.com"));
  assert.equal(validTimezone("Europe/Oslo"), true);
  assert.equal(validTimezone("Not/AZone"), false);
});
test("event contract bounds batches, properties, and paired identity", () => {
  const message = { id: randomUUID(), type: "event", name: "signup_completed" };
  assert.equal(envelopeSchema.safeParse({ events: [message] }).success, true);
  assert.equal(
    envelopeSchema.safeParse({ events: [{ ...message, source: "server" }] }).success,
    false,
  );
  assert.equal(
    envelopeSchema.safeParse({ events: [{ ...message, visitorId: randomUUID() }] }).success,
    false,
  );
  assert.equal(
    envelopeSchema.safeParse({ events: Array.from({ length: 21 }, () => message) }).success,
    false,
  );
  assert.equal(propertiesSchema.safeParse({ nested: { email: "no" } }).success, false);
  assert.equal(
    propertiesSchema.safeParse({ valid: "yes", amount: 10, finished: true }).success,
    true,
  );
});
test("request parser enforces actual streamed payload size", async () => {
  await assert.rejects(
    readJson(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({ value: "a".repeat(50) }),
      }),
      32,
    ),
    /too large/,
  );
  await assert.rejects(
    readJson(new Request("http://localhost", { method: "POST", body: "invalid" })),
    /Invalid JSON/,
  );
});

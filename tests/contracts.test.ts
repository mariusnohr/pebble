import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  cleanPath,
  envelopeSchema,
  normalizeOrigins,
  propertiesSchema,
  projectSchema,
  validTimezone,
} from "../src/lib/contracts";
import { readJson } from "../src/server/http";

test("agent context accepts 4,000 Unicode characters and rejects 4,001 without trimming", () => {
  const project = {
    name: "Test",
    origins: "https://example.test",
    timezone: "UTC",
    retentionDays: 90,
  };
  for (const character of ["a", "🙂", " "]) {
    const agentContext = character.repeat(4000);
    assert.equal(projectSchema.parse({ ...project, agentContext }).agentContext, agentContext);
    const invalid = projectSchema.safeParse({ ...project, agentContext: agentContext + character });
    assert.equal(invalid.success, false);
    if (!invalid.success)
      assert.equal(
        invalid.error.issues[0].message,
        "Agent context must be at most 4,000 characters.",
      );
  }
});

test("multipart agent context counts normalized newlines at the 4,000-character boundary", async () => {
  const submitted = async (agentContext: string) => {
    const form = new FormData();
    form.set("name", "Test");
    form.set("origins", "https://example.test");
    form.set("timezone", "UTC");
    form.set("retentionDays", "90");
    form.set("agentContext", agentContext);
    const request = new Request("https://pebble.test/settings", { method: "POST", body: form });
    return Object.fromEntries(await request.formData());
  };
  for (const character of ["a", "🙂"]) {
    for (const newline of ["\n", "\r\n", "\r"]) {
      const value = character.repeat(3998) + newline + "b";
      const expected = character.repeat(3998) + "\nb";
      const input = await submitted(value);
      assert.equal(input.agentContext, character.repeat(3998) + "\r\nb");
      assert.equal(projectSchema.parse(input).agentContext, expected);
      const invalid = projectSchema.safeParse(await submitted(value + "c"));
      assert.equal(invalid.success, false);
      if (!invalid.success)
        assert.equal(
          invalid.error.issues[0].message,
          "Agent context must be at most 4,000 characters.",
        );
    }
  }
});

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

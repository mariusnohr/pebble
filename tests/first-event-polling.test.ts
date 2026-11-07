import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { pollFirstEvent } from "../src/lib/first-event-polling";

class Page extends EventTarget {
  visibilityState = "visible";
  show(state: string) {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

test("first-event polling pauses hidden tabs, resumes immediately, and stops after receipt", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const page = new Page();
  Object.defineProperty(globalThis, "document", { configurable: true, value: page });
  const received: string[] = [];
  let time: string | null = null;
  const fetch = t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "/api/projects/test/first-event");
    assert.equal(init.cache, "no-store");
    assert.equal(init.credentials, "same-origin");
    return Response.json({ firstEventAt: time });
  });
  const stop = pollFirstEvent("test", (value) => received.push(value));
  t.after(() => {
    stop();
    Reflect.deleteProperty(globalThis, "document");
  });
  await setImmediate();
  assert.equal(fetch.mock.callCount(), 1);
  t.mock.timers.tick(4999);
  assert.equal(fetch.mock.callCount(), 1);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(fetch.mock.callCount(), 2);
  page.show("hidden");
  t.mock.timers.tick(30000);
  assert.equal(fetch.mock.callCount(), 2);
  time = "2026-11-07T12:00:00.000Z";
  page.show("visible");
  await setImmediate();
  assert.deepEqual(received, [time]);
  t.mock.timers.tick(30000);
  page.show("hidden");
  page.show("visible");
  assert.equal(fetch.mock.callCount(), 3);
});

test("hidden mounting and cleanup prevent requests; stale in-flight responses are ignored", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const page = new Page();
  page.show("hidden");
  Object.defineProperty(globalThis, "document", { configurable: true, value: page });
  let finish!: (response: Response) => void;
  let signal: AbortSignal | undefined;
  const fetch = t.mock.method(globalThis, "fetch", (_: string, init: RequestInit) => {
    signal = init.signal!;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  });
  const received: string[] = [];
  const stop = pollFirstEvent("test", (time) => received.push(time));
  t.after(() => {
    stop();
    Reflect.deleteProperty(globalThis, "document");
  });
  t.mock.timers.tick(10000);
  assert.equal(fetch.mock.callCount(), 0);
  page.show("visible");
  t.mock.timers.tick(10000);
  assert.equal(fetch.mock.callCount(), 1, "requests must not overlap");
  page.show("hidden");
  assert.equal(signal?.aborted, true);
  finish(Response.json({ firstEventAt: "2026-11-07T12:00:00.000Z" }));
  await setImmediate();
  assert.deepEqual(received, []);
  stop();
  page.show("visible");
  t.mock.timers.tick(10000);
  assert.equal(fetch.mock.callCount(), 1);
});

test("transient failures retry but a missing or inaccessible project stops polling", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const page = new Page();
  Object.defineProperty(globalThis, "document", { configurable: true, value: page });
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    attempts++;
    if (attempts === 1) throw new Error("offline");
    return new Response(null, { status: attempts === 2 ? 503 : 404 });
  });
  const stop = pollFirstEvent("test", () => assert.fail("no event received"));
  t.after(() => {
    stop();
    Reflect.deleteProperty(globalThis, "document");
  });
  await setImmediate();
  t.mock.timers.tick(5000);
  await setImmediate();
  t.mock.timers.tick(5000);
  await setImmediate();
  assert.equal(attempts, 3);
  t.mock.timers.tick(10000);
  page.show("visible");
  assert.equal(attempts, 3);
});

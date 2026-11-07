import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getLegalHtml, getLegalTextAvailability } from "../src/server/legal";
import robots from "../src/app/robots";
import sitemap from "../src/app/sitemap";

test("missing and blank legal texts are unavailable; committed Markdown renders", async (t) => {
  t.mock.method(fs, "readFile", async (file: string) => {
    assert.equal(path.dirname(file), path.join(process.cwd(), "src/content/legal"));
    switch (path.basename(file)) {
      case "terms.md":
        return "## Using Pebble\n\n- First rule\n- Second rule\n\n1. One\n2. Two\n\n[Privacy](/legal/privacy)";
      case "privacy.md":
        return " \n\t ";
      default:
        throw Object.assign(new Error("Missing file"), { code: "ENOENT" });
    }
  });

  assert.deepEqual(await getLegalTextAvailability(), { terms: true, privacy: false, dpa: false });
  assert.equal(await getLegalHtml("privacy"), null);
  assert.equal(await getLegalHtml("dpa"), null);
  const html = await getLegalHtml("terms");
  assert.ok(html);
  assert.match(html, /<h2>Using Pebble<\/h2>/);
  assert.match(html, /<ul>\s*<li>First rule<\/li>/);
  assert.match(html, /<ol>\s*<li>One<\/li>/);
  assert.match(html, /<a href="\/legal\/privacy">Privacy<\/a>/);
});

test("legal content read failures are not silently treated as missing texts", async (t) => {
  t.mock.method(fs, "readFile", async () => {
    throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
  });
  await assert.rejects(getLegalHtml("terms"), { code: "EACCES" });
  await assert.rejects(getLegalTextAvailability(), { code: "EACCES" });
});

test("public discovery uses the APP_URL origin for every legal page", (t) => {
  // Node's test runner isolates this file in its own process.
  const previousOrigin = process.env.APP_URL;
  t.after(() => {
    if (previousOrigin === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousOrigin;
  });
  process.env.APP_URL = "https://pebble.example/base/";
  const slugs = ["terms", "privacy", "dpa"];
  assert.deepEqual(
    sitemap(),
    slugs.map((slug) => ({ url: `https://pebble.example/legal/${slug}` })),
  );
  assert.deepEqual(robots(), {
    rules: { userAgent: "*", allow: "/", disallow: ["/app", "/api", "/operator", "/invite"] },
    sitemap: "https://pebble.example/sitemap.xml",
  });
});

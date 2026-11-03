import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
await mkdir("public", { recursive: true });
await Promise.all([
  build({
    entryPoints: ["packages/analytics/src/browser.ts"],
    outfile: "packages/analytics/dist/browser.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
  }),
  build({
    entryPoints: ["packages/analytics/src/server.ts"],
    outfile: "packages/analytics/dist/server.js",
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  }),
  build({
    entryPoints: ["packages/analytics/src/snippet.ts"],
    outfile: "public/tracker.v1.js",
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
  }),
]);

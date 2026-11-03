# Pebble

- Build for normal Node.js and PostgreSQL. Do not add Docker or hosting-platform setup; deployment will be handled separately.
- Keep browser and server tracking on a shared contract. Server events must never create browser presence.
- Enforce admin authentication at each protected read and mutation, and preserve project isolation in ingestion.
- Run `pnpm check` and `pnpm build` for application changes. Database behavior is covered by `pnpm test:integration` against a dedicated `pebble_test*` database.

## Current documentation

Use Context7 for library, framework, SDK, API, and CLI work, even for familiar APIs. Start with `resolve-library-id`, choose the best relevant official source, then use `query-docs` scoped to one concept at a time. Prefer Context7 over web search for library documentation. General programming and library-independent refactoring do not require a documentation lookup.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

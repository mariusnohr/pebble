# Pebble

A small, self-hosted analytics workspace for your websites. Next.js App Router, PostgreSQL, Drizzle, and shadcn/ui with Base UI. One admin password. Browser and Node.js tracking. Light, dark, and system themes.

## Local setup

Requires Node.js 22+ (a supported LTS release), pnpm, and PostgreSQL 17+. Pebble runs as a normal Node.js application. Database provisioning and hosting are up to you.

1. Install dependencies:

   ```sh
   pnpm install
   ```

2. Create a Postgres database, copy `.env.example` to `.env.local`, and set `DATABASE_URL` and `APP_URL`. Generate a password hash with:

   ```sh
   pnpm password:hash
   ```

   Paste the generated `ADMIN_PASSWORD_HASH` line into `.env.local`, preserving its single quotes. There is no default password. Changing this hash invalidates existing admin sessions. The database user needs permission to run migrations and access Pebble's tables.

3. Apply migrations and start the app:

   ```sh
   pnpm db:migrate
   pnpm dev
   ```

Open http://localhost:3000, sign in, create a project, and follow its Settings page to connect a tracker. `APP_URL` must match the origin you use to access Pebble, including the port; mutations check it to prevent cross-origin requests.

## Normal Node.js operation

```sh
pnpm build
pnpm db:migrate
pnpm start
```

Supply environment variables through your own setup. Run migrations once as a release step, not on every request. `pnpm start` uses Next.js's Node server; no platform-specific runtime or external queue is required. Keep Postgres persistent and backed up.

`GET /api/health` checks the process; `GET /api/ready` checks the database and migrated schema. The build does not require a live database or production secrets.

Run `pnpm db:cleanup` daily using your own scheduler to enforce each project's retention and remove expired sessions/rate-limit buckets. The default retention is 90 days. Cleanup deletes raw history permanently; there are no long-term rollups yet.

Leave `TRUST_PROXY=false` unless a trusted reverse proxy overwrites `X-Real-IP` and direct access to Node is blocked. Without it, rate limits use a shared bucket. Pebble never persists raw IP addresses. Production `APP_URL` should use HTTPS so the admin cookie is secure.

## Browser tracking

The project Settings page provides an embeddable script. Use it once per page, or install the TypeScript SDK below. Automatic collection covers the initial visible page, History API navigation, and visible-page heartbeats. It drops URL queries and fragments while capturing only `utm_source`, `utm_medium`, and `utm_campaign` separately. Referrers are reduced to hostnames.

```ts
import { createTracker } from "@pebble/analytics/browser";

const pebble = createTracker({
  endpoint: "https://analytics.example.com",
  projectId: "your-project-uuid",
});

pebble.track("newsletter_opened", { placement: "footer" });
```

Initialize in a browser lifecycle, not during server rendering. For a React/Next.js integration, create the tracker in a client component effect and call `tracker.destroy()` in its cleanup. Mount one tracker per project. Set `autoPageviews: false` when you want explicit pageview calls; do not send the same pageview from both browser and server automatically.

### Consent and identity

A random per-project visitor ID lives in first-party local storage for 30 days. A visit expires after 30 minutes without activity. Tabs share the same storage; unavailable storage falls back to page-local memory. Counts describe browsers, not identified people. Projects do not share identities.

To start disabled, use `enabled: false` with the SDK or `data-consent="required"` on the script. Then call `pebble.setEnabled(true)` when permitted. Calling `setEnabled(false)` stops collection, clears pending events, and removes local identifiers. It cannot retract already-sent events. Apply your site's consent/opt-out decision to server tracking too.

The embed snippet creates a queue for `track()` calls before the script loads. To queue consent before loading, use `window.pebble.q.push(["setEnabled", true])`. After loading, `window.pebble` exposes the full browser tracker.

## Node.js tracking

The SDK is included in `packages/analytics`; it has not been published to npm. Build and package it locally:

```sh
pnpm sdk:build
pnpm --dir packages/analytics pack
```

Install the generated `.tgz` archive in a consuming project using your package manager, or use your own workspace/private registry. The package exports ESM with TypeScript declarations and requires Node.js 22+ for server use.

Create a server API key in project Settings and save it in the consuming application's server environment. Keys are write-only, project-scoped, hashed at rest, and individually revocable.

```ts
import { createClient } from "@pebble/analytics/server";

const pebble = createClient({
  endpoint: "https://analytics.example.com",
  apiKey: process.env.PEBBLE_API_KEY!,
});

// Run after the application operation has succeeded.
const result = await pebble.track("newsletter_signup_completed", {
  placement: "footer",
});

if (!result.ok) {
  // Report the analytics failure without undoing the successful operation.
  console.warn(result.error);
}
```

The client sends immediately, returns an awaitable result, and uses bounded timeouts and retries. It has no in-memory background queue to flush. Await it, or use your framework's supported response-lifecycle mechanism (e.g. Next.js `after()` in a handler/action). Delivery is best-effort across process crashes; it is not a durable outbox.

### Connect browser activity to server outcomes

Send `pebble.getContext()` from the browser to **your own** backend alongside the application request. Validate the context and attach it only to that request's resulting event:

```ts
await serverPebble.track(
  "signup_completed",
  { source: "newsletter" },
  {
    context: { visitorId, visitId },
    id: stableEventUuid,
  },
);
```

Both context identifiers must be UUIDs. They are analytics metadata, never authentication credentials. The SDK does not keep a global current visitor. Jobs and webhooks may omit context entirely; they count as events without manufacturing visits or online activity.

Give repeated attempts of the same logical operation the same UUID. SDK transport retries preserve their generated ID; application-level retries must pass a stable ID. Events with the same project and ID are stored once, including concurrent requests. If browser and server deliberately send the same event, share that ID; otherwise use different event names for intent and confirmed outcome.

## Tracking API v1

| Endpoint               | Access                                       | Purpose                              |
| ---------------------- | -------------------------------------------- | ------------------------------------ |
| `GET /tracker.v1.js`   | Public                                       | Browser bundle                       |
| `POST /api/v1/collect` | Public project ID and allowed browser origin | Pageviews, custom events, heartbeats |
| `POST /api/v1/events`  | `Authorization: Bearer pb_…`                 | Server pageviews and custom events   |

Both POST endpoints accept `{ "events": [...] }`; browser requests also require a top-level `projectId`. A server key determines its project; a conflicting supplied project ID is rejected.

Each message has a UUID `id`, `type` (`pageview`, `event`, or browser-only `heartbeat`), optional ISO `timestamp`, paired optional `visitorId`/`visitId`, and optional `path`. Custom events require `name`; pageviews and heartbeats require `path`. Browser messages require both identity fields. `properties` accepts up to 20 scalar values (string, finite number, boolean, or null), with 256-character string values and bounded property names. Nested objects are rejected. Payloads are limited to 32 KiB and 20 messages. Event names use letters, digits, `.`, `_`, and `-`, start with a letter, and are at most 100 characters.

Server timestamps may be up to 7 days old or 5 minutes ahead. Browser events use server receipt time to avoid clock-skew problems. All rows retain receipt time, source, and event occurrence time. Source is assigned by the receiving endpoint.

Success is returned only after the database transaction commits: `{ accepted, duplicates, ignored }`. Malformed payloads are rejected as a whole. The browser origin allowlist prevents accidental misuse, but public browser telemetry can be spoofed. Server keys provide authenticated ingestion. Basic known-crawler filtering is heuristic.

Keep custom properties free of personal information. Pebble does not capture form contents, full user agents, or raw IPs. It does not yet implement country lookup, session replay, funnels, bounce rate, or engagement duration.

## Reports and presence

- Visitors: distinct visitor IDs in events within the selected period.
- Visits: distinct visit IDs in that period; a visit spanning two periods may appear in both.
- Pageviews: accepted pageview events. API requests are not counted automatically.
- Events: accepted custom events, split by browser/server source.
- Online: distinct visitor IDs with a browser pageview or visible-page heartbeat received within 60 seconds. Background jobs and server-only events cannot update presence. Visible tabs heartbeat every 20 seconds; live views poll every 10 seconds.

Times are stored in UTC. Project reports use the configured IANA timezone. Range comparisons use the immediately preceding interval of equal elapsed length. The workspace's 7-day summary is a rolling window and counts each project's visitors separately. Browser/OS/device parsing is intentionally coarse. A browser tracker cannot measure blocked scripts or every request handled by your servers.

## Development checks

```sh
pnpm lint          # ESLint: Next.js + TypeScript, zero warnings
pnpm lint:fix      # Apply supported lint fixes
pnpm format        # Prettier: rewrite source formatting
pnpm format:check  # Check formatting without changes
pnpm typecheck     # Generate route types and check TypeScript
pnpm test          # Unit and SDK tests
pnpm check         # Formatting, lint, types, and unit tests
```

Database integration tests need a **dedicated** database whose name starts with `pebble_test`. They apply migrations, create isolated fixtures, and clean up their projects:

```sh
TEST_DATABASE_URL=postgresql://localhost:5432/pebble_test pnpm test:integration
```

Use `pnpm db:generate` after editing `src/db/schema.ts`. Commit generated SQL and metadata, then apply with `pnpm db:migrate`. Do not use schema push as the production migration workflow.

## Repository layout

- `src/app`: App Router UI, private admin routes, and public ingestion routes.
- `src/components`: Pebble interface and generated shadcn/Base UI primitives.
- `src/server`: authentication, project actions, ingestion, rate limiting, reports.
- `src/db`: Drizzle schema and the shared Postgres pool.
- `src/lib/contracts.ts`: payload and project validation.
- `packages/analytics`: browser and Node SDK source, with a shared transport.
- `drizzle`: versioned database migrations.
- `scripts`: SDK build, password hashing, and retention cleanup.
- `tests`: unit and real-Postgres integration tests.

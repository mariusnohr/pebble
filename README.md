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
pnpm start
```

`pnpm build` produces a standalone Next.js server and applies pending database migrations when `DATABASE_URL` is set. Without `DATABASE_URL` the migration step is skipped, so local builds do not need a live database. You can also run `pnpm db:migrate` separately as a release step; it is idempotent. `pnpm start` serves the build with Next.js's Node server. Keep Postgres persistent and backed up.

### Environment variables

| Variable              | Required    | Purpose                                                                                                                                                                  |
| --------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`        | Yes         | PostgreSQL connection string. The database user needs permission to run migrations and access Pebble's tables.                                                           |
| `APP_URL`             | Yes         | Public origin used for the admin cookie and same-origin checks, for example `https://pebble.example.com`. It must match exactly, including the port in development.      |
| `ADMIN_PASSWORD_HASH` | Yes         | The `scrypt$…` value printed by `pnpm password:hash`. Paste only the value, without the `ADMIN_PASSWORD_HASH=` prefix. Changing it invalidates admin sessions.           |
| `TRUST_PROXY`         | No          | Set to `true` only when a trusted reverse proxy overwrites `X-Real-IP` and Node is not directly reachable. Defaults to `false`, which uses one shared rate-limit bucket. |
| `PORT` / `HOSTNAME`   | No          | The standalone server reads these when starting. Most hosts provide them; they are not normally set by hand.                                                             |
| `RESEND_API_KEY`      | For email   | Resend API key. Enables the Resend HTTP transport unless explicit log mode is selected.                                                                                  |
| `EMAIL_FROM`          | With Resend | Verified sending address, optionally with a display name, e.g. `Pebble <notifications@example.com>`.                                                                     |
| `EMAIL_TRANSPORT`     | No          | Set to `log` **on preview only** to log recipient, subject and links instead of sending. Never set log mode in production.                                               |

`TEST_DATABASE_URL` is only used by the integration tests. `GET /api/health` checks the process; `GET /api/ready` checks the database and migrated schema.

### Background jobs and email

Next.js instrumentation starts the in-process runner in the Node runtime when `DATABASE_URL` is set. It does not start during `next build` or in the Edge runtime. No external scheduler or separate worker is needed. The runner ticks immediately at startup and every 30 seconds thereafter:

| Job               | Schedule           | Work                                                                                                                       |
| ----------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `retention`       | Daily at 03:00 UTC | Delete events by `occurred_at` and visits by `last_seen_at`, using each project's retention.                               |
| `purge`           | Daily at 03:30 UTC | Delete expired admin sessions and rate-limit buckets, finished jobs older than 7 days, and outbox rows older than 30 days. |
| `outbox`          | Every tick         | Send due queued emails, at most 25 rows / roughly 20 seconds per run (an in-flight request may take another 10 seconds).   |
| `legacy_projects` | Every tick         | Assign projects with NULL `organization_id` to the legacy Pebble organization during the M1 rollback window.               |

Daily schedules have unique keys such as `retention:2026-11-08`. Startup catches up the most recent due day and schedules the next day. Claims use `FOR UPDATE SKIP LOCKED` and two-minute leases. PostgreSQL advisory locks allow at most one running job per kind across overlapping app processes, even when a run outlasts its lease. A disconnected worker's lease can be reclaimed. Handlers must be idempotent; SQL cleanup safely repeats committed batches, and Resend deduplicates sends with the outbox UUID as `Idempotency-Key`. Every completed/failed run emits one JSON line with `kind`, `duration_ms` and `outcome`; startup emits `job_runner_started`. Payloads and exception messages are never included in job logs.

Failed jobs receive at most five retries after the initial attempt, delayed by 30 seconds, 2, 5, 10 and 20 minutes. Exhausted jobs retain a `last_error` and `finished_at`. Email attempts use the same backoff, with a 10-second HTTP timeout and a hard one-hour window from the first attempt, including time spent down. Timeouts, network errors, HTTP 5xx, 409, 408 and 429 retry; other HTTP failures stop immediately. The sender persists attempts before HTTP, and records `sent_at` and `provider_id` only after success. A crash after provider acceptance retries with the same key. `next_attempt_at` also leases an in-flight outbox row for one minute. The `created_at` and `first_attempt_at` outbox columns provide durable purge and retry clocks.

`pnpm db:cleanup` remains available for manual maintenance. It calls the same `cleanupRetention` and `purgeMaintenance` functions as the jobs, keeping all deletes bounded to 5,000 rows per statement. Effective retention is the project's own setting until plans arrive; the default is 90 days. Cleanup permanently deletes raw history; there are no long-term rollups yet.

Feature code queues mail **inside the transaction that makes its corresponding change**, using `queueEmail` from `src/server/email/queue.ts`:

```ts
await db.transaction(async (tx) => {
  // Persist the feature's change with tx, then queue its email with the same tx.
  await queueEmail(tx, {
    to: "colleague@example.com",
    template: "message",
    data: {
      subject: "Project update",
      heading: "Your project was updated",
      paragraphs: ["Open the project to see the change."],
      organizationName: "Acme",
      projectName: "Website",
      links: [{ label: "Open project", path: "/projects/project-id" }],
    },
  });
});
```

`queueEmail` returns the outbox UUID. The generic `message` template is a foundation; product templates are added in `src/server/email/templates.ts` with their features. The shared plain layout escapes HTML, includes organization/project names when provided, and renders a text alternative. Link paths must resolve within `APP_URL`; external links are rejected.

Without `RESEND_API_KEY` or explicit `EMAIL_TRANSPORT=log`, queued rows become `failed` with `failure_reason=not_configured`. Startup warns **once per process**: `Email is not configured`. Failure logs contain only the template and a fixed reason, never provider responses, links, tokens or recipients. Explicit preview log mode prints recipient, subject and links, and marks the row sent; it is a diagnostic transport and cannot guarantee deduplicated log output across crashes. Resend mode additionally requires `EMAIL_FROM` and a verified sending domain. Set `APP_URL` to the public origin used in email links.

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

Database integration tests need a **dedicated, disposable** database whose name starts with `pebble_test`. **The cutover test resets its public and Drizzle schemas**, applies only migration 0000, seeds data through a frozen copy of the `abb7927a` schema, and then applies all migrations. It checks preserved values, old-release queries, and the runner backfill. Never point integration tests at a restored dump you want to rehearse. Test files run sequentially (`--test-concurrency=1`) because they share migrations and exercise global maintenance jobs; the job suite uses concurrent connections to test overlapping workers. Email HTTP requests are mocked:

```sh
TEST_DATABASE_URL=postgresql://localhost:5432/pebble_test pnpm test:integration
```

Use `pnpm db:generate` after editing `src/db/schema.ts`. Commit generated SQL and metadata, then apply with `pnpm db:migrate`. Do not use schema push as the production migration workflow.

### M1 expand and rollback window

**M1 migrations must remain additive until the M2 contract step.** Migrations run during the build while the previous release still serves requests. Keep existing tables, columns, constraints and indexes; do not drop, rename, retype or set existing columns NOT NULL. New columns must be nullable or have defaults. `tests/migrations.test.ts` conservatively enforces this for every migration after 0000 (including new tables) and tests rejected SQL examples. Lift that guard only in the M2 contract task.

Migration 0002 adds the account schema, `audit_log`, `usage_periods`, nullable `projects.organization_id`, and `projects.agent_context` (default empty, at most 4,000 characters). Its idempotent data step creates **Pebble**, slug `pebble`, with a **Business** override and assigns existing projects. `LEGACY_ORGANIZATION_ID` in `src/server/legacy-organization.ts` is stable even if the name or slug changes. New projects created by this release receive it immediately. Projects created by an old release during a build or rollback are assigned at startup or the next 30-second runner tick. Explicit organization assignments are never overwritten.

Admin-password sign-in and all existing dashboard and tracking routes remain active in this expand-only release. `admin_sessions`, `rate_limits`, ingest keys, events and visits retain their old shape. Better Auth is configured solely for schema generation in `src/server/auth-options.ts`; there is no `/api/auth` route. No feature writes audit or usage entries yet. Account sign-in, ownership claims and authorization switch in the later accounts task; dropping legacy auth and requiring project organizations wait until M2. Keep `ADMIN_PASSWORD_HASH` throughout the rollback window.

Better Auth, its Drizzle adapter and its current CLI package (`auth`) are pinned together. To regenerate the auth tables:

```sh
pnpm exec auth generate --config src/server/auth-options.ts --adapter drizzle --dialect postgresql --output src/db/auth-schema.ts --yes
```

Before `pnpm db:generate`, retain the documented project additions in `auth-schema.ts`: timezone-aware timestamps, the plan/role/resend checks, unique `(organization_id, user_id)` membership and the partial unique owner index. Better Auth's own database rate limiter uses **`rate_limit`**; the pre-existing **`rate_limits`** stays unchanged. No new runtime auth secret is needed until Better Auth is mounted.

### Rehearse the production cutover

Before merging the expand step, the owner restores the latest nightly `pebble` dump into a **new `pebble_test_cutover` database with its own local role** (currently under 10 MB), then supplies its URL as `TEST_DATABASE_URL` through the environment. Keep this copy offline: no app or job runner may write to it during the rehearsal.

```sh
# TEST_DATABASE_URL must already point at the restored pebble_test_cutover copy.
pnpm db:rehearse
```

The command rejects non-test database names, verifies the connected database's name, records every existing public table's row count, applies pending Drizzle migrations, and prints the before/after counts. It fails if any existing count changes, if the Pebble/business organization is missing, or if any project is outside it. New tables are expected and excluded from the before/after comparison. Re-running a successful rehearsal is safe. It never resets schemas, logs connection strings, or prints restored records; unlike integration tests, it preserves the restored data.

Attach the complete successful output to the PR, then have the owner drop the rehearsal database. Also run `pnpm test:integration` on the separate disposable `pebble_test` database. After the platform deploys the preview, verify admin sign-in, project creation and existing histories, then send a pageview to `/api/v1/collect` with a project's allowed Origin and check Realtime. The rehearsal and preview checks are required before merging.

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

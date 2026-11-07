# Pebble

A small, self-hosted analytics workspace for your websites. Next.js App Router, PostgreSQL, Drizzle, and shadcn/ui with Base UI. Verified accounts and organization-scoped dashboards. Browser and Node.js tracking. Light, dark, and system themes.

## Local setup

Requires Node.js 22+ (a supported LTS release), pnpm, and PostgreSQL 17+. Pebble runs as a normal Node.js application. Database provisioning and hosting are up to you.

1. Install dependencies:

   ```sh
   pnpm install
   ```

2. Create a Postgres database, copy `.env.example` to `.env.local`, and set `DATABASE_URL`, `APP_URL`, and a randomly generated `BETTER_AUTH_SECRET` (at least 32 bytes). Set `OPERATOR_EMAILS` to your email address. Use `EMAIL_TRANSPORT=log` for local development and `SIGNUP_OPEN=true` if you want to test non-operator sign-up. The database user needs permission to run migrations and access Pebble's tables.

3. Apply migrations and start the app:

   ```sh
   pnpm db:migrate
   pnpm dev
   ```

Open http://localhost:3000/signup, create an account, and open the verification link from the development log. Create an organization and a project, then follow its Settings page to connect a tracker. An operator claims the existing Pebble organization when they first verify. `APP_URL` must match the origin you use to access Pebble, including the port; mutations check it to prevent cross-origin requests.

## Normal Node.js operation

```sh
pnpm build
pnpm start
```

`pnpm build` produces a standalone Next.js server and applies pending database migrations when `DATABASE_URL` is set. Without `DATABASE_URL` the migration step is skipped, so local builds do not need a live database. You can also run `pnpm db:migrate` separately as a release step; it is idempotent. `pnpm start` serves the build with Next.js's Node server. Keep Postgres persistent and backed up.

### Environment variables

| Variable              | Required       | Purpose                                                                                                                                                        |
| --------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`        | Yes            | PostgreSQL connection string; the role must be able to apply migrations.                                                                                       |
| `APP_URL`             | Yes            | Exact public origin, including the port locally. Better Auth base URL, trusted origin, cookie security and email links use it.                                 |
| `BETTER_AUTH_SECRET`  | Yes            | At least 32 random bytes, generated separately for preview and production. Signs Better Auth cookies/JWTs and salts Pebble's rate-limit keys.                  |
| `OPERATOR_EMAILS`     | Before cutover | Comma-separated, case-insensitive operator emails. Bypass the launch gate; the first to verify claims Pebble.                                                  |
| `SIGNUP_OPEN`         | No             | Only the exact value `true` opens public signup. Keep unset in production through the rollback window; use `true` on preview.                                  |
| `TRUST_PROXY`         | Behind Caddy   | Set `true` only when the trusted proxy supplies the **last** `X-Forwarded-For` entry and Node is not directly reachable. Otherwise all clients share a bucket. |
| `RESEND_API_KEY`      | Production     | Resend API key for transactional verification and security emails.                                                                                             |
| `EMAIL_FROM`          | With Resend    | Address on a Resend-verified domain, optionally `Pebble <notifications@example.com>`.                                                                          |
| `EMAIL_TRANSPORT`     | No             | `log` on local development/preview only logs mail and verification links. Never enable it in production.                                                       |
| `ADMIN_PASSWORD_HASH` | Rollback only  | Keep the existing value until M2's contract deploy. This release never reads it; `abb7927a` still needs it.                                                    |
| `PORT` / `HOSTNAME`   | No             | Standalone server listener settings, normally supplied by the host.                                                                                            |

`TEST_DATABASE_URL` is only used by the integration tests. `GET /api/health` checks the process; `GET /api/ready` checks the database and migrated schema.

### Background jobs and email

Next.js instrumentation starts the in-process runner in the Node runtime when `DATABASE_URL` is set. It does not start during `next build` or in the Edge runtime. No external scheduler or separate worker is needed. The runner ticks immediately at startup and every 30 seconds thereafter:

| Job               | Schedule           | Work                                                                                                                                                                                                                      |
| ----------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retention`       | Daily at 03:00 UTC | Delete events by `occurred_at` and visits by `last_seen_at`, using each project's retention.                                                                                                                              |
| `purge`           | Daily at 03:30 UTC | Delete expired account sessions, verification rows and rate-limit buckets, audit entries older than 365 days, finished jobs older than 7 days and outbox rows older than 30 days. Legacy admin sessions remain untouched. |
| `outbox`          | Every tick         | Send due queued emails, at most 25 rows / roughly 20 seconds per run (an in-flight request may take another 10 seconds).                                                                                                  |
| `legacy_projects` | Every tick         | Assign projects with NULL `organization_id` to the legacy Pebble organization during the M1 rollback window.                                                                                                              |

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

`queueEmail` returns the outbox UUID. The templates are `message`, `verifyEmail` and `signupAttempt` in `src/server/email/templates.ts`. Account creation and verification mail are committed together. Existing-account signup attempts queue a security notice without a verification link. The shared plain layout escapes HTML, includes organization/project names when provided, and renders a text alternative. Link paths must resolve within `APP_URL`; external links are rejected.

Without `RESEND_API_KEY` or explicit `EMAIL_TRANSPORT=log`, queued rows become `failed` with `failure_reason=not_configured`. Startup warns **once per process**: `Email is not configured`. Failure logs contain only the template and a fixed reason, never provider responses, links, tokens or recipients. Explicit preview log mode prints recipient, subject and links, and marks the row sent; it is a diagnostic transport and cannot guarantee deduplicated log output across crashes. Resend mode additionally requires `EMAIL_FROM` and a verified sending domain. Set `APP_URL` to the public origin used in email links.

Leave `TRUST_PROXY=false` unless a trusted reverse proxy supplies the last `X-Forwarded-For` entry and direct access to Node is blocked. Without it, rate limits use a shared bucket. Pebble never persists raw IP addresses. Production `APP_URL` should use HTTPS so the account session cookie is secure.

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

Errors return `{ "error": "Human-readable message.", "code": "stable_machine_code" }`:

| Status | Code                | Meaning                                                                      |
| ------ | ------------------- | ---------------------------------------------------------------------------- |
| 400    | `invalid_payload`   | Missing or malformed JSON, invalid messages, timestamps or visitor identity. |
| 413    | `payload_too_large` | Request body exceeds 32 KiB.                                                 |
| 401    | `unauthorized`      | Missing, invalid or revoked server ingest key.                               |
| 403    | `unauthorized`      | A supplied project ID conflicts with the server key's project.               |
| 403    | `forbidden_origin`  | Browser origin is missing, `null` or not in the project's allowlist.         |
| 404    | `project_not_found` | Project does not exist.                                                      |
| 403    | `project_paused`    | Project collection is paused.                                                |
| 429    | `rate_limited`      | Request rate limit exceeded; `Retry-After: 60` indicates when to retry.      |
| 503    | `unavailable`       | Collection is temporarily unavailable.                                       |

`/api/v1/collect` permits **600 requests per minute per client IP** and **6,000 per minute per project**. With `TRUST_PROXY=true`, `clientAddress()` uses the last `X-Forwarded-For` entry supplied by the trusted proxy; otherwise clients share one IP bucket. `/api/v1/events` permits **6,000 requests per minute per ingest key**; keys belonging to the same project have independent limits. Limits use fixed one-minute windows. Both SDKs stop retries on all 4xx responses, including 429.

Rate limits precede payload validation and project checks. Browser requests consume the IP limit before the body is read, and the project limit as soon as a valid project ID can be extracted from JSON. Server requests first authenticate the key to identify its bucket. After payload validation, collection checks that the project exists, the browser origin is allowed, and the project is not paused, in that order. A refused batch stores no events, visits or usage.

Monthly organization usage increases by newly stored pageviews and custom events from both endpoints, in the same transaction as the batch. Heartbeats still contribute to the response's `accepted` count but never to usage; duplicates and ignored crawlers also do not count. Usage belongs to the UTC calendar month (`YYYY-MM`) when the batch is received, including backdated server events. It is never recomputed or decreased by project deletion or retention cleanup. Projects with no organization yet count toward the legacy Pebble organization. Usage recording starts with this release; quotas and suspension checks are not yet enforced.

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

Migration 0002 adds the account schema, `audit_log`, `usage_periods`, nullable `projects.organization_id`, and `projects.agent_context` (default empty, at most 4,000 characters). Its idempotent data step creates **Pebble**, slug `pebble`, with a **Business** override and assigns existing projects. `LEGACY_ORGANIZATION_ID` in `src/server/legacy-organization.ts` is stable even if the name or slug changes. New projects created by this release receive their current organization ID immediately. Projects created by an old release during a build or rollback are assigned at startup or the next 30-second runner tick. Explicit organization assignments are never overwritten.

This release is the **production account cutover**. Admin-password sign-in is removed; all dashboards live under `/app/{org}`. A shared guard resolves organization membership and project ownership; missing or unauthorized resources return 404. A NULL project organization still means legacy Pebble until backfill runs. Members can read but only owners/admins can mutate projects and ingest keys. Mutations write an actor-labelled audit row in the same transaction. `admin_sessions`, `rate_limits`, ingest keys, events and visits keep their old shape. No destructive migration is introduced.

`/projects/{id}[/…]` responds with a 307 to the scoped URL for members and 404 otherwise. `/` redirects to `/app` or `/login`; `/app` uses `user.last_organization_id` when membership still exists, otherwise `/app/new`. New organizations get a unique generated slug and owner membership, with a limit of five owned organizations. `/app/account` supports name changes; security settings and invitations are separate tasks.

Authentication is mounted at `/api/auth/[...all]` through `handleAuth` in `src/server/auth-handler.ts`. This wrapper permits only sign-up, sign-in, sign-out, get-session, verification and resend endpoints. Do not expose the organization plugin's raw CRUD routes: those would bypass Pebble's slug and ownership rules. Future auth features must extend the allowlist with their authorization/rate limits. `signupAllowed(email)` in `src/server/signup-gate.ts` is the single launch policy for the invitations task to extend.

Passwords are 10–128 characters, names are 1–80 characters and email addresses are lower-cased. Email verification lasts 24 hours and signs the user in. Verification takes a user-row lock before checking `email_verified`, so replayed/concurrent uses fail instead of reusing Better Auth's stateless JWT. The legacy ownership claim runs inside the same verification transaction. Signup is limited to 5/hour/IP, sign-in to 10/5 minutes/IP and resends to 3/hour/address through the existing DB-backed `rateLimit()`. Better Auth's own limiter and IP tracking are disabled; Pebble uses the last trusted forwarded address and stores only salted bucket hashes.

Sessions last 14 days and roll after 24 hours of use. Cookies are httpOnly, SameSite=Lax and Secure on HTTPS. Server-rendered session checks disable refresh; `SessionRefresh` calls the auth endpoint to apply rolling cookies in the browser. **Spec §7 exception:** Better Auth 1.7.18 stores its session token in `session.token` as plaintext and has no supported hashed-session-token option (checked its session options and database adapter). We retain its supported session storage instead of implementing custom token storage. Ingest keys remain SHA-256 hashed.

Better Auth, its Drizzle adapter and its current CLI package (`auth`) are pinned together. To regenerate the auth tables:

```sh
NODE_OPTIONS=--conditions=react-server pnpm exec auth generate --config src/server/auth-options.ts --adapter drizzle --dialect postgresql --output src/db/auth-schema.ts --yes
```

Before `pnpm db:generate`, retain the documented project additions in `auth-schema.ts`: timezone-aware timestamps, the plan/role/resend checks, unique `(organization_id, user_id)` membership and the partial unique owner index. The generated Better Auth **`rate_limit`** table remains unused; runtime limits use the existing **`rate_limits`** table. Keep the existing organization/two-factor plugin schema configuration even while their unfinished HTTP endpoints are blocked.

### Rehearse the production cutover

Before merging the account cutover, the owner restores the latest nightly `pebble` dump into a **new `pebble_test_cutover` database with its own local role** (currently under 10 MB), then supplies its URL as `TEST_DATABASE_URL` through the environment. Keep this copy offline: no app or job runner may write to it during the rehearsal.

```sh
# TEST_DATABASE_URL must already point at the restored pebble_test_cutover copy.
pnpm db:rehearse
```

The command rejects non-test database names, verifies the connected database's name, records every existing public table's row count, applies pending Drizzle migrations, and prints the before/after counts. It fails if any existing count changes, if the Pebble/business organization is missing, or if any project is outside it. New tables are expected and excluded from the before/after comparison. Re-running a successful rehearsal is safe. It never resets schemas, logs connection strings, or prints restored records; unlike integration tests, it preserves the restored data.

Attach the complete successful rehearsal output to the PR, then have the owner drop the rehearsal database. Run `pnpm test:integration` on a **separate disposable** `pebble_test*` database. The tenancy suite exercises actual Better Auth handlers, session cookies, guarded queries, server actions and realtime/legacy routes. It covers the launch gate, duplicate signup, required/repeated/expired verification, concurrent operator claims, tenant isolation, member denial, resend limits, sign-in limits, organization creation/deletion, sign-out and maintenance.

### Production cutover runbook

1. **Before merging:** confirm the restored-copy schema rehearsal passed. Create a Resend account, verify its sending domain using the supplied DNS records, and supply production `RESEND_API_KEY` and all-target `EMAIL_FROM` and `OPERATOR_EMAILS`. Generate separate preview and production `BETTER_AUTH_SECRET` values through Nohr. Set `TRUST_PROXY=true` for both targets. Approve production-reaching configuration before deploying. These are application/configuration changes; no additional server packages or workers are needed.
2. **Preview prerequisites:** set `SIGNUP_OPEN=true` and `EMAIL_TRANSPORT=log` only on preview. Deploy this branch through the platform. Sign up with an operator address, get its verification link from the runtime log, verify, and confirm `/app/pebble` contains all legacy projects and historical analytics. Open the link again and confirm the already-used error and Resend email control.
3. **Isolation rehearsal:** sign up a second user, verify, create an organization/project, and confirm the first organization's project pages, key mutations and realtime return 404. Check legacy `/projects/{id}` gives the owner a 307 and the second user 404. Make 11 failed sign-ins from one final forwarded IP: the eleventh must return 429, while another final IP remains independent. Confirm duplicate signup displays the same Check your email screen but queues only a signup-attempt notice.
4. **Rollback rehearsal (platform/owner):** deploy `abb7927a` to an isolated `rollback-check` preview using the same **preview** database and retained `ADMIN_PASSWORD_HASH`. Sign in with the admin password, POST a valid pageview to `/api/v1/collect`, and confirm it appears in the new app. Remove the rollback preview afterwards. It must never be exposed to other preview users: the old dashboard can see every organization's projects. This repository task does not push or create/delete remote branches.
5. **Merge is the cutover:** merging to main immediately retires the admin password. Keep `SIGNUP_OPEN` unset in production. After deployment, sign up at `/signup` with an `OPERATOR_EMAILS` address and verify using the delivered email. The first verified operator becomes Pebble's owner. Confirm all project IDs, histories and tracking integrations are intact before marking the cutover successful.
6. **Rollback window:** keep `ADMIN_PASSWORD_HASH` and all additive tables until M2. Production rollback to `abb7927a` is supported **only while no other organization has projects**; the old dashboard has no tenancy. If rollback is needed in this window, the platform/owner redeploys that commit against the same database, then can redeploy this release without losing data. The M2 contract migration must wait for successful production claim/confirmation; it drops `admin_sessions`, requires organization IDs and closes rollback. Only then delete `ADMIN_PASSWORD_HASH`.

If email, the auth secret, the operator list, the disposable integration database, or rehearsal evidence is missing, complete those prerequisites before merging. A local typecheck/unit pass does not substitute for the live email and rollback checks.

## Repository layout

- `src/app`: App Router UI, organization-scoped account routes, and public ingestion routes.
- `src/components`: Pebble interface and generated shadcn/Base UI primitives.
- `src/server`: authentication, project actions, ingestion, rate limiting, reports.
- `src/db`: Drizzle schema and the shared Postgres pool.
- `src/lib/contracts.ts`: payload and project validation.
- `packages/analytics`: browser and Node SDK source, with a shared transport.
- `drizzle`: versioned database migrations.
- `scripts`: SDK build, cutover rehearsal, and retention cleanup.
- `tests`: unit and real-Postgres integration tests.

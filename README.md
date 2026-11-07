# Pebble

A small, self-hosted analytics workspace for your websites. Next.js App Router, PostgreSQL, Drizzle, and shadcn/ui with Base UI. Verified accounts and organization-scoped dashboards. Browser and Node.js tracking. Light, dark, and system themes.

## Local setup

Requires Node.js 22+ (a supported LTS release), pnpm, and PostgreSQL 17+. Pebble runs as a normal Node.js application. Database provisioning and hosting are up to you.

1. Install dependencies:

   ```sh
   pnpm install
   ```

2. Create a Postgres database, copy `.env.example` to `.env.local`, and set `DATABASE_URL`, `APP_URL`, and a randomly generated `BETTER_AUTH_SECRET` (at least 32 bytes). Set `OPERATOR_EMAILS` to your email address. Use `EMAIL_TRANSPORT=log` for local development and `SIGNUP_OPEN=true` if you want to test non-operator sign-up. The database user needs permission to run migrations and access Pebble's tables.

3. On a fresh database, apply through M1 so you can create and verify the legacy owner before contraction:

   ```sh
   pnpm db:migrate --through-m1
   pnpm dev
   ```

Open http://localhost:3000/signup, create an account with your `OPERATOR_EMAILS` address, and open the verification link from the development log. Verification claims the existing Pebble organization. For this local database only, set `F3_CONTRACT_CONFIRMATION=local-development-verified-owner` in `.env.local`, then run `pnpm db:migrate` to apply the contraction. Create projects under your organization and follow their Settings pages to connect trackers. Do not use the local confirmation value on a deployed database; production evidence is required below. `APP_URL` must match the origin you use to access Pebble, including the port; mutations check it to prevent cross-origin requests.

## Normal Node.js operation

```sh
pnpm build
pnpm start
```

`pnpm build` produces a standalone Next.js server and applies pending database migrations when `DATABASE_URL` is set. Without `DATABASE_URL` the migration step is skipped, so local builds do not need a live database. You can also run `pnpm db:migrate` separately as a release step; it is idempotent. `pnpm start` serves the build with Next.js's Node server. Keep Postgres persistent and backed up.

### Environment variables

| Variable                   | Required           | Purpose                                                                                                                                                               |
| -------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`             | Yes                | PostgreSQL connection string; the role must be able to apply migrations.                                                                                              |
| `APP_URL`                  | Yes                | Exact public origin, including the port locally. Better Auth base URL, trusted origin, cookie security and email links use it.                                        |
| `BETTER_AUTH_SECRET`       | Yes                | At least 32 random bytes, generated separately for preview and production. Signs Better Auth cookies/JWTs and salts Pebble's rate-limit keys.                         |
| `OPERATOR_EMAILS`          | Before cutover     | Comma-separated, case-insensitive operator emails. Bypass the launch gate; the first to verify claims Pebble.                                                         |
| `SIGNUP_OPEN`              | No                 | Only the exact value `true` opens public signup. Keep unset in production through the rollback window; use `true` on preview.                                         |
| `TRUST_PROXY`              | Behind Caddy       | Set `true` only when the trusted proxy supplies the **last** `X-Forwarded-For` entry and Node is not directly reachable. Otherwise all clients share a bucket.        |
| `RESEND_API_KEY`           | Production         | Resend API key for transactional verification and security emails.                                                                                                    |
| `EMAIL_FROM`               | With Resend        | Address on a Resend-verified domain, optionally `Pebble <notifications@example.com>`.                                                                                 |
| `EMAIL_TRANSPORT`          | No                 | `log` on local development/preview only logs mail and verification links. Never enable it in production.                                                              |
| `F3_CONTRACT_CONFIRMATION` | Before contraction | Non-secret reference to the owner’s recorded production M1 verification and legacy ownership claim. Required for migration 0005 on each target; ignored once applied. |
| `PORT` / `HOSTNAME`        | No                 | Standalone server listener settings, normally supplied by the host.                                                                                                   |

`ADMIN_PASSWORD_HASH` is obsolete: no application code reads it. Delete it from Nohr target `all` only after contraction succeeds in production. `TEST_DATABASE_URL` is supplied only to implementer/test processes and must never be an application env var. `GET /api/health` checks the process; `GET /api/ready` checks the database and migrated schema.

### Background jobs and email

Next.js instrumentation starts the in-process runner in the Node runtime when `DATABASE_URL` is set. It does not start during `next build` or in the Edge runtime. No external scheduler or separate worker is needed. The runner ticks immediately at startup and every 30 seconds thereafter:

| Job               | Schedule           | Work                                                                                                                                                                              |
| ----------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retention`       | Daily at 03:00 UTC | Delete events by `occurred_at` and visits by `last_seen_at`, using each project's retention.                                                                                      |
| `purge`           | Daily at 03:30 UTC | Delete expired account sessions, verification rows and rate-limit buckets, audit entries older than 365 days, finished jobs older than 7 days and outbox rows older than 30 days. |
| `outbox`          | Every tick         | Send due queued emails, at most 25 rows / roughly 20 seconds per run (an in-flight request may take another 10 seconds).                                                          |
| `legacy_projects` | Every tick         | M1 compatibility backfill; a harmless no-op after contraction because `organization_id` is required.                                                                              |

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

Monthly organization usage increases by newly stored pageviews and custom events from both endpoints, in the same transaction as the batch. Heartbeats still contribute to the response's `accepted` count but never to usage; duplicates and ignored crawlers also do not count. Usage belongs to the UTC calendar month (`YYYY-MM`) when the batch is received, including backdated server events. It is never recomputed or decreased by project deletion or retention cleanup. Before contraction, projects with no organization count toward the legacy Pebble organization. Usage recording started with M1; quotas and suspension checks are not yet enforced.

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

Database integration tests need a **dedicated, disposable** database whose name starts with `pebble_test`, supplied by the owner as `TEST_DATABASE_URL` to the implementer process. **The cutover and contract suites reset its public and Drizzle schemas.** Never point these tests at the restored dump used by `db:rehearse`, or at either application database. Test files run sequentially (`--test-concurrency=1`); individual tests use concurrent connections to exercise overlapping workers. Email HTTP requests are mocked.

```sh
# TEST_DATABASE_URL is already supplied to this process; do not log its value.
pnpm test:integration
```

- `cutover.test.ts` starts at 0000 using the frozen `abb7927a` schema, then stops at **0002**, the expand boundary. It preserves the old admin-session, ingestion, NULL-project usage/tenancy/deletion and runner compatibility tests.
- `contract.test.ts` starts at **0004**, the last M1 migration. It checks failed prerequisites without mutation, exact preservation of project settings/history/keys/memberships/usage, the final backfill, absent admin table, required organization IDs, and journal replay. It waits for the migrator's pending project lock before completing concurrent M1 project creation/update and their audit writes. It uses a frozen M1 project shape for old-release writes and exercises membership reads, both ingestion handlers, readiness, scheduled purge and `pnpm db:cleanup` against the contracted schema.
- Other integration suites use `prepareContractDatabase` to claim a disposable fixture owner and migrate to the final schema. Fixtures supply organization IDs explicitly. This test-only claim/confirmation is never deployment evidence.

Use `pnpm db:generate` after editing `src/db/schema.ts`. Commit generated SQL and metadata, then apply with `pnpm db:migrate`. Do not use schema push as the production migration workflow.

### Account and organization workflow

All dashboards use verified accounts and organization membership under `/app/{org}`. Members can read; owners/admins can mutate projects and ingest keys. Missing or unauthorized resources return 404, and mutations record actor-labelled audit entries in the same transaction. Public sign-up remains closed unless `SIGNUP_OPEN=true`; operators and valid invitees can pass the launch gate. Contraction does not open sign-up.

`/projects/{id}[/…]` retains its authorized 307 redirect to the scoped URL and returns 404 otherwise. `/app` chooses the last-used organization when membership still exists. New organizations receive an owner membership and unique slug; an account can own at most five. `/app/account` includes profile, password, two-factor authentication, sessions and deletion controls. Organization settings and invitations are under `/app/{org}/settings`.

Authentication is mounted at `/api/auth/[...all]` through `handleAuth` in `src/server/auth-handler.ts`. Extend its restricted endpoint allowlist deliberately; do not expose the organization plugin's raw CRUD routes. `signupAllowed(email)` in `src/server/signup-gate.ts` owns the launch policy, including invitations.

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

The command rejects non-test database names, verifies the connected database's name, records every existing public table's row count, applies Drizzle migrations **only through 0002 (expand)**, and prints the before/after counts. It fails if any existing count changes, if the Pebble/business organization is missing, or if any project is outside it. New tables are expected and excluded from the before/after comparison. Re-running a successful rehearsal is safe. It never resets schemas, logs connection strings, or prints restored records; unlike integration tests, it preserves the restored data.

Attach the complete successful rehearsal output to the PR, then have the owner drop the rehearsal database. Run `pnpm test:integration` on a **separate disposable** `pebble_test*` database. The tenancy suite exercises actual Better Auth handlers, session cookies, guarded queries, server actions and realtime/legacy routes. It covers the launch gate, duplicate signup, required/repeated/expired verification, concurrent operator claims, tenant isolation, member denial, resend limits, sign-in limits, organization creation/deletion, sign-out and maintenance.

### F3 contraction: standalone first M2 deployment

Migrations run before the replacement release builds, while M1 continues serving. Migration **0005_contract_legacy_admin** closes the pre-M1 rollback window. It requires a nonempty `F3_CONTRACT_CONFIRMATION` reference and the stable legacy organization (`8d3b7c14-a8c9-4ae4-91e9-a9cf44232f1b`) with a verified owner. Name/slug changes do not invalidate the check. The owner claims through an `OPERATOR_EMAILS` account, never by inserting production fixture rows. The migration locks the claim during contraction, serializes project inserts with the final NULL backfill, sets `projects.organization_id NOT NULL`, and drops `admin_sessions` without CASCADE. Its organization guard uses `FOR NO KEY UPDATE`, compatible with the foreign-key `KEY SHARE` locks of in-flight M1 project and audit writes while the migration waits for the projects table. Drizzle commits these changes and its journal entry together; a guard failure rolls them back. A repeated migration run makes no changes and does not require the confirmation again.

**Deployment is blocked until the owner records their production claim and M1 confirmation in the Nohr task/release evidence.** A nonempty config reference is an explicit deployment gate, not independent proof of that confirmation. Neither test fixtures nor a successful build substitutes for owner evidence. This checkout contains no owner confirmation.

1. **Finish M1 in production first.** Verify delivered email, account sign-in, ownership of Pebble, all legacy project IDs/settings/histories, authorized legacy redirects, and existing browser/server ingestion. Confirm production `BETTER_AUTH_SECRET`, `OPERATOR_EMAILS`, `TRUST_PROXY`, `EMAIL_FROM` and `RESEND_API_KEY` are configured. Keep public sign-up closed. Record the production release SHA, owner user ID, verification time and results in Nohr.
2. **Prepare this deployment alone.** Record the confirmation evidence reference in `F3_CONTRACT_CONFIRMATION` on preview and propose it on production through Nohr. Set it only after the owner has confirmed production M1; do not use a placeholder or local/test reference. Retain the existing `DATABASE_URL` settings for `pebble_preview` and `pebble`; provision no new application database. Ensure Pebble is also claimed on preview before its migration. Do not batch billing, public-site or other M2 changes with this deployment.
3. **Verify before approval.** Run `pnpm check` and `pnpm test:integration` against the owner-provided disposable `pebble_test*` database, including both migration boundaries. Let Nohr build/deploy candidate. Record the candidate release SHA and migration 0005 journal timestamp, then use an existing verified account to check sign-in and historical project reads. Check `/projects/{id}` and its events/realtime/settings paths redirect with 307 for a member and return 404 to an outsider. Check `/api/ready` returns 200, scheduled retention/purge succeed, and `pnpm db:cleanup` completes without `admin_sessions`. Send a pageview through an **existing installed snippet** and an event with an **existing server ingest key**; verify both persisted IDs in the project history. Confirm zero NULL organization IDs and absence of `admin_sessions` on candidate. Attach actual results before approving production.
4. **Deploy contraction as the first M2 release.** Approve production only after the preceding evidence is complete. Record its SHA/time and migration result separately from later M2 work. Repeat account, redirects, readiness, cleanup and ingestion checks in production. Only after success, delete `ADMIN_PASSWORD_HASH` from target `all`. Do not queue that deletion to apply before this deployment.

Minimum supported rollback after contraction: **the complete M1 release `d5b83b22` (the parent production release of this task), or a later compatible release**. It already supplies organization IDs on project creation, uses account sessions, and has no admin-table dependency in readiness, cleanup, reads or ingestion. If the replacement build fails after migration, keep or redeploy that M1 release against the contracted database. **Never deploy `abb7927a` after migration 0005.** Recreating an empty admin table or relaxing the constraint is not a supported rollback. Recovery to pre-M1 would require restoring an earlier database backup and losing later writes, outside this task's supported procedure.

Deployment evidence to attach in Nohr (these are prerequisites, not claimed results):

| Evidence              | Required record                                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner approval        | Owner identity, verified production user ID, production M1 SHA, claim/confirmation timestamp and explicit confirmation of the checks above           |
| Test database         | Owner-provided `pebble_test*` availability and successful check/integration output, without connection strings                                       |
| Candidate             | Release SHA, migration timestamp, preserved project/history checks, member/outsider redirects, readiness/cleanup and both persisted ingest event IDs |
| Standalone production | F3 release SHA/time before any other M2 deploy, migration/check results, and subsequent `ADMIN_PASSWORD_HASH` deletion                               |

Historical M1 migrations **0001–0004 remain additive** and are still protected by `tests/migrations.test.ts`. Migration 0002 created the Pebble/business organization and nullable project ownership; the historical rollback/rehearsal tools intentionally stop there. `pnpm db:migrate --through-m1` stops at 0004 for local account bootstrap; it never reverses an already-applied contraction.

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

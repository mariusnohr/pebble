# Pebble — Spec

Version 2 · 2026-11-07 · Source of truth for planning, building and testing.

Status markers used below: **Exists** (in `main` today, keep behaviour), **Changes** (exists, behaviour changes as described), **New** (to build).

Changes from version 1:
- New build order: the agent, Query API and MCP now come before goals and funnels, monitors, briefings, pins, raw export, the audit-log page and the operator console. All of these stay on the roadmap.
- The cutover from the single-admin app now uses an expand-and-contract migration, with a rollback window.
- Event usage is now recorded when each batch is stored, so the quota can no longer be overshot.
- Metric definitions are now one fixed contract, backed by fixture tests.
- Ask Pebble answers now cite their query cards.
- Other changes: Stripe webhooks are protected against out-of-order delivery; monitor transitions are fully defined; email delivery and logging rules are stricter; public sign-up waits behind a launch gate; the capacity figures are corrected.

## 1. Overview

### What it is

Pebble is a hosted, privacy-respecting analytics service for websites and products, built **agent-first**. The main way to get answers out of it is to ask.

- **Ask Pebble**, the built-in analytics agent, answers questions in plain language by running real queries you can inspect against the business's data.
- It writes scheduled briefings and explains alerts on its own.
- The same query engine is open to the customer's own AI agents through an API and an MCP server.
- Classic dashboards remain for at-a-glance reading and for checking the agent's work.

### Who it is for

Small and mid-sized businesses (SaaS companies, e-commerce shops, agencies, content businesses) that run one or more websites or web apps. Someone there — a founder, marketer, product manager or developer — needs reliable numbers and explanations, without an analyst or a SQL warehouse.

### Problem it solves

- Dashboards show *what* happened; people still have to dig to find *why* and *what to do*. Pebble's agent does the digging and shows its queries.
- Analytics tools do not plug into the AI agents businesses already use. Pebble's Query API and MCP server make the data available to those agents with a scoped key that can be revoked.
- Many tools collect personal data. Pebble stores no raw IPs, no full user agents, no URL query strings and no cross-site identity (existing behaviour, kept).

### Where it starts from

Today Pebble is a self-hosted, single-admin analytics workspace, protected by one password from `ADMIN_PASSWORD_HASH`. It has:
- projects;
- browser and Node.js tracking on a shared contract;
- overview, realtime and events reports;
- project-scoped server ingest keys;
- a retention script.

This spec turns it into a multi-tenant SaaS with user accounts, organizations, paid plans through Stripe, and the agent features. Existing tracking contracts, project IDs and installed snippets keep working unchanged.

### Success looks like

- A new business can sign up, verify their email, create an organization and a project, install the snippet and see their first event within 10 minutes, without help.
- They can ask "Why did signups drop last week?" and get an answer in which every figure cites a query card they can inspect and export. Causes are presented as correlations, not as proof.
- They can upgrade to a paid plan with a card in Stripe Checkout, and the new limits apply within a minute.
- Their own agent (Claude Code, Cursor, any MCP client) can query their analytics with a read key.
- The dashboard, the agent, the Query API and MCP return identical numbers for identical queries.

### Goals

1. Accounts, organizations with roles, and Stripe subscriptions with enforced plan limits.
2. One typed, project-scoped query engine shared by the dashboard, the agent, the API and MCP.
3. An agent that answers questions with verifiable queries and proposes changes without ever making them silently. Later on the roadmap, it also works proactively through briefings and monitors.
4. Business-grade basics: goals and funnels, filters, custom ranges, CSV and raw export, an audit log, 2FA and data deletion.
5. Runs on the existing single VPS as one Next.js process with PostgreSQL.

### Non-goals

- A self-hosted edition (see D1, Q9).
- A data warehouse, SQL console or BI tool. Users and agents query only through the typed query engine.
- Identifying individual people: no `identify()`, no user profiles, no PII.
- Session replay, heatmaps, A/B testing, geo/country analytics (see §10).

### Build order

The planner delivers features in this order. Each milestone leaves the product deployable.

| Milestone | Features | Notes |
| --- | --- | --- |
| M1 Accounts & tenancy | F1, F2, F3 (expand step), F4, F5, F18 (recording only), F19, F20, F21 (legal pages and public shell) | The production deploy needs the F3 prerequisites. Sign-up stays behind the launch gate (F1). |
| M2 Billing & public site | F3 (contract step, as the first deploy), F6, F7, F21 (landing, pricing, docs for live features) | Plan limits start applying. |
| M3 Analytics core | F8 (without goal metrics and funnels), F9, F17 (report CSV only) | |
| M4 Agent & agent access | F11 (core tools), F15, F16 | The public site and docs gain Ask, Query API and MCP sections. |
| M5 Goals & funnels | F10 | Adds goal metrics and funnel queries, plus their agent, API and MCP tools. |
| M6 Proactive agent | F13, F14 | |
| M7 Pinned insights | F12 | |
| M8 Business readiness | F17 (raw export), F18 (audit-log page), F22 | Suspension and plan overrides become operable. |

Rules for building in this order:
- Parts of a feature that depend on a later feature are marked "(with Fn)" and ship with that later feature. Until then the control, tool, metric, email or docs section is absent — not shown as disabled. Examples: Pin buttons arrive with F12; `propose_monitor` arrives with F13.
- A "Done when" check that involves a later feature is verified when that feature ships.
- Public pages and docs describe only features that are live in the same deploy (F21).

## 2. Users and roles

| Who | Description |
| --- | --- |
| **Prospect** | Anyone on the public site (landing, pricing, docs, legal). Has no account. |
| **User** | A person with a verified Pebble account. Belongs to zero or more organizations, with one role in each. |
| **Owner** | Exactly one per organization. Can do everything an admin can, plus billing, transferring ownership and deleting the organization. |
| **Admin** | Manages projects, tracking keys, read API keys, goals, and members and invitations (except the owner). Manages organization settings except deletion and billing. Views the audit log. |
| **Member** | Reads all of the organization's projects and reports. Uses Ask Pebble; creates funnels, pins and monitors; subscribes to briefings; exports report CSVs. Cannot change projects, keys, goals, members or billing. |
| **Operator** | Pebble staff: a verified user whose email is listed in `OPERATOR_EMAILS`. Can use the operator console (F22) and sign up while the launch gate is closed (F1). Has no access to customers' analytics data. |
| **Tracked visitor** | A browser visiting a customer's website. Never signs in. Identified only by a random per-project ID in local storage (existing). |
| **Machine clients** | Holders of an **ingest key** (`pb_…`, project-scoped, write-only, existing) or a **read key** (`pbr_…`, organization-scoped, read-only, new). |

### Permission matrix

Rows for features from later milestones apply once those features ship.

| Action | Owner | Admin | Member |
| --- | :-: | :-: | :-: |
| View projects, reports, realtime, briefings, monitors, pins | ✓ | ✓ | ✓ |
| Use Ask Pebble (own conversations only) | ✓ | ✓ | ✓ |
| Create/edit/delete own funnels, pins, monitors | ✓ | ✓ | ✓ |
| Edit/delete anyone's funnels, pins, monitors | ✓ | ✓ | – |
| Export report CSVs | ✓ | ✓ | ✓ |
| Export raw events | ✓ | ✓ | – |
| Create/edit/pause/delete projects; edit agent context | ✓ | ✓ | – |
| Create/revoke ingest keys and read keys | ✓ | ✓ | – |
| Create/edit/delete goals | ✓ | ✓ | – |
| Invite, remove, change role of members and admins | ✓ | ✓ | – |
| Rename organization, change slug, toggle AI features | ✓ | ✓ | – |
| View plan and usage | ✓ | ✓ | ✓ |
| Start checkout, open Stripe billing portal, cancel/restore subscription | ✓ | – | – |
| Transfer ownership, delete organization | ✓ | – | – |
| View audit log | ✓ | ✓ | – |

Every protected page, route handler, server action and API endpoint checks the caller's membership and role in the organization that owns the addressed resource. Hiding a control is never the only check. A resource ID that belongs to another organization gets exactly the same response as a non-existent one (404).

## 3. Features

### F1 — Accounts and sign-in

**Status: New** (replaces the single admin password).

- **Sign up** at `/signup`:
  - Fields: name (1–80 chars), email, password (10–128 chars), and a checkbox accepting the Terms and Privacy Policy (links to the F21 pages).
  - Emails are case-insensitive and unique.
  - Signing up with an existing email shows the same "Check your email" screen as a new sign-up, so accounts cannot be enumerated. That address receives a "someone tried to sign up" notice instead of a verification link.
- **Launch gate** (D21): public sign-up is open only when the env var `SIGNUP_OPEN` is `true`.
  - While the gate is closed, sign-up works only for addresses listed in `OPERATOR_EMAILS` or with a pending invitation (F2).
  - Any other address sees "Pebble isn't open for sign-up yet", and nothing is stored or sent.
  - Sign-in, password reset and invitations work normally either way.
  - Preview sets `SIGNUP_OPEN=true`. The owner sets it in production at launch (Q13).
- **Email verification** is required before any `/app` page can be used.
  - The link is valid for 24 hours and works once.
  - Unverified users who sign in see "Verify your email" with a "Resend email" button (max 3 sends per hour per address).
  - Expired or already-used links show an error with a resend button.
- **Sign in** at `/login` with email and password.
  - Wrong credentials show "Email or password is incorrect", whichever of the two was wrong.
  - If 2FA is enabled, a second step asks for a 6-digit TOTP code or a backup code.
- **Forgot password** at `/forgot-password`:
  - Always shows "If an account exists, we sent a link".
  - The reset link is valid for 1 hour and works once.
  - Resetting signs out all of the user's sessions and sends a "your password was changed" email.
- **Sessions**: an httpOnly, `SameSite=Lax` cookie, `Secure` on HTTPS. Lifetime is 14 days, extended when the session is used more than 24 hours after it started. Sign out ends the current session.
- **Account page** `/app/account`:
  - Change name.
  - Change password: requires the current password; an option "Sign out other sessions" is checked by default.
  - List active sessions (device/browser summary, created, last active) and revoke any except the current one.
  - Enable 2FA: scan a QR code or enter the secret, confirm with a code, then see 10 single-use backup codes once.
  - Regenerate backup codes.
  - Disable 2FA (requires password).
- **Delete account** (requires the password and typing `DELETE`):
  - Blocked while the user owns an organization that has other members: "Transfer ownership or remove members first".
  - Organizations where the user is the only member are deleted with the account, with the same effect as F2 "Delete organization".
  - The user's conversations are deleted. Funnels, pins and monitors they created stay with their organizations.
- **Rate limits** (per client IP, and per email where applicable):
  - sign-in: 10 attempts per 5 min;
  - sign-up: 5 per hour per IP;
  - forgot-password: 3 per hour per email;
  - 2FA code attempts: 5 per 5 min per session.

  Going over a limit shows "Too many attempts. Try again in a few minutes." (HTTP 429 for API calls).
- Social login, magic links, SSO and email-address changes are out of scope (§10).

Done when:
- A new user can sign up and receives a verification email. They cannot open `/app` until verified, and can after clicking the link.
- Sign-in fails with the generic message for a wrong email and for a wrong password. The 11th attempt within 5 minutes from one IP is refused.
- A password reset link works once, expires after 1 hour, and signs out other browsers.
- A user with 2FA enabled cannot sign in without a valid TOTP or backup code. Each backup code works once.
- Revoking a session on the account page signs out that browser on its next request.
- Deleting an account removes the user, their sole-member organizations and their conversations.
- With `SIGNUP_OPEN` unset, a non-invited address cannot sign up, while an invited address and an `OPERATOR_EMAILS` address can.

### F2 — Organizations, members and roles

**Status: New.**

- An **organization** has:
  - a name (1–60 chars);
  - a URL slug: 3–40 chars, `a-z0-9-`, unique, generated from the name, editable by the owner or an admin. Reserved slugs: `account`, `new`, `invitations`, `operator`, `api`, `app`;
  - an AI-features toggle (default on, see F11);
  - a plan (F6);
  - members.
- **Create** at `/app/new`. Any verified user may create up to 5 organizations, as owner. The creator becomes the owner, and the organization starts on the Free plan.
- **First run** after verification:
  - a user with no organizations and no pending invitations lands on `/app/new`;
  - a user with pending invitations sees them at `/app/invitations` with Accept / Decline, plus "Create an organization instead".
- **Switching**: the sidebar shows the current organization with a switcher listing all the user's organizations and "Create organization". `/app` redirects to the last-used organization.
- **Invitations** (owner/admin): email plus role (admin or member).
  - Valid for 7 days and usable once. The email contains an accept link to `/invite/{token}`.
  - Accepting requires being signed in as a verified user whose email matches the invited address (case-insensitive). Otherwise the page says which address the invitation is for and offers sign-in or sign-up.
  - Pending invitations can be revoked or resent (max 3 resends per invitation per day).
  - Inviting an existing member, or an address that already has a pending invitation, is rejected with a clear message.
  - Members plus pending invitations may not exceed the plan's seat limit (F6, from M2).
- **Members page** `/app/{org}/settings/members`:
  - Lists members (name, email, role, joined) and pending invitations (email, role, expires).
  - The owner and admins can switch a person between member and admin, and remove members and admins.
  - Nobody can change or remove the owner. Any non-owner can leave the organization.
- **Ownership transfer** (owner only, requires password): pick an existing admin. They become owner and the former owner becomes admin. Both receive an email.
- **Removing a member, or a member leaving**:
  - The person loses access immediately: their next request to that organization's pages returns 404.
  - Their conversations in the organization's projects are deleted. Their funnels, pins and monitors remain.
  - They are removed from monitor recipients (F13 explains what happens when that empties a monitor's recipient list) and from briefing subscriptions.
- **Delete organization** (owner only; type the organization name to confirm):
  - Cancels any Stripe subscription immediately, with no refund.
  - Immediately deletes all projects and their analytics, keys, goals, funnels, pins, monitors, briefings, conversations, invitations, usage records and the audit log.
  - Stripe keeps its customer record and invoices.
  - Database backups (nightly, 7-day retention) may still contain the data for up to 7 days.
- **Suspended organizations** (with F22):
  - Members can still sign in and see the banner "This organization is suspended. Contact support."
  - All reads remain available. All mutations except billing and deletion are refused.
  - Ingestion is refused (F5).

Done when:
- Owner, admin and member each see exactly the actions in the permission matrix. A member calling an admin-only action server-side gets an error, and nothing changes.
- An invitation accepted with the matching email adds the member with the invited role. A different signed-in email cannot accept it. An expired invitation shows "This invitation has expired".
- A user who belongs to two organizations can switch between them, and projects from one never appear in the other.
- Requesting another organization's project, conversation, pin, monitor or key by ID returns 404.
- Deleting an organization removes its projects. Its former tracking snippet then receives 404 from `/api/v1/collect`.

### F3 — Migration from the single-admin workspace

**Status: New.** One-time, in two steps: an **expand** step in M1 and a **contract** step in M2 (D23). Background: `pnpm build` applies migrations to the live database before Nohr switches over to the new release. So while the build runs, the old release keeps serving against the already-migrated schema. It must also keep working if the new release fails to build or is rolled back.

**Expand step** (the M1 migration):
- **Additive changes only.** It may create new tables and add new columns to existing tables, but only nullable columns or columns with defaults. No existing table, column, constraint or index is dropped, renamed or retyped. In particular, `admin_sessions` and the current shape of `projects`, `events`, `visits`, `project_api_keys` and `rate_limits` stay usable by the pre-M1 release (commit `abb7927a`).
- **Legacy organization.** It creates one organization named **"Pebble"** (slug `pebble`) and assigns every existing project to it. A project created through the old release after the migration ran (during the build) also belongs to this organization.
- **Nothing breaks.** Project IDs, origins, settings, events, visits and ingest keys are kept, so installed snippets and server SDK clients keep working without any change.
- **Plan override.** The legacy organization gets a **Business** plan override (stored on the organization, F22), so no existing retention setting exceeds its plan.
- **Ownership claim.** The organization has no owner until the first user whose email is in `OPERATOR_EMAILS` verifies their email. That user then becomes its owner automatically. Until then it has no members, and nobody can open it in the app.
- **Old sign-in retired.** The new release no longer reads `ADMIN_PASSWORD_HASH` or `admin_sessions`: admin-password sign-in is gone, and the rate-limit key salt switches to `BETTER_AUTH_SECRET`.
- **Old URLs.** Old dashboard URLs `/projects/{id}[/…]` redirect (307) to `/app/{slug}/projects/{id}[/…]` for signed-in members of the project's organization, and return 404 otherwise.
- **Usage.** Usage counting (F7) starts at the cutover. The legacy organization's usage for the cutover month includes only batches accepted by the new release.
- **Where it runs.** The step runs on both the production (`pebble`) and preview (`pebble_preview`) databases through the normal build-time migration.

**Rollback window** (between the expand and contract deploys):
- Redeploying `abb7927a` against the expanded database keeps working: admin-password sign-in, the dashboard and ingestion all function.
- Redeploying the M1 commit afterwards restores the new app with no data lost.
- Rollback is supported only while no organization other than the legacy one has projects. Reason: the old dashboard shows every project in the database to whoever holds the admin password. This is why public sign-up stays closed (F1) until the contract step has run.

**Contract step** (the first migration of M2):
- It is deployed only after the owner has claimed the legacy organization in production and confirmed that M1 works there.
- It drops `admin_sessions` and makes `projects.organizationId` required. Any project still without an organization is first assigned to the legacy organization.
- After this deploy the owner deletes the `ADMIN_PASSWORD_HASH` env var. From this point on, a rollback to the pre-M1 release is no longer possible.

**Prerequisites before M1 reaches production** (owner actions, §6). Once M1 is live, the admin password stops working and the operator can only get in by verifying an email address. So production must already have:
- `RESEND_API_KEY` and `EMAIL_FROM`, on a verified sending domain;
- `BETTER_AUTH_SECRET`;
- `OPERATOR_EMAILS`;
- `TRUST_PROXY`;
- a completed cutover rehearsal (below).

**Verification**:
- **Integration test**: start a test database at the pre-M1 schema, seeded with legacy-shaped data (projects, events, visits, ingest keys, admin sessions), and apply the M1 migration. Every row must be preserved, every project must belong to the legacy organization, and the pre-M1 release's ingestion and admin-session queries must still succeed.
- **Rehearsal**: the owner restores the latest nightly dump of `pebble` into a `pebble_test_cutover` database. The expand migration and the integration checks are run against that copy before M1 merges.
- **First live cutover**: the M1 preview deploy (on `pebble_preview`, which holds data from the old app).

Done when:
- After the M1 deploy, existing projects appear under the "Pebble" organization for the operator who signs up with their `OPERATOR_EMAILS` address, with all historical data intact.
- An existing tracker snippet keeps recording pageviews without modification, including while the build that applies the migration is running.
- `/login` no longer accepts the admin password, and `/projects/{id}` redirects for the owner.
- On preview, deploying `abb7927a` after the M1 migration still allows admin sign-in and ingestion. Deploying M1 again then shows all data, including events ingested meanwhile.
- After the contract deploy, `admin_sessions` no longer exists and every project has an organization.

### F4 — Projects and tracking setup

**Status: Exists — changes:** projects belong to an organization; limits come from the plan (from M2); new agent-context field; new first-event check.

- **A project** is one website or app. It has:
  - a name (1–60 chars);
  - 1–20 allowed browser origins (exact origins, existing rules);
  - a reporting timezone (IANA, existing);
  - retention in days: from 7 up to the plan's maximum, default `min(90, plan max)`;
  - a paused flag (existing);
  - **agent context** (new): free text of at most 4,000 chars, for example "signup_completed fires when a trial starts; /pricing is our main funnel entry". It is included in every Ask Pebble prompt for the project (with F11), and in every briefing and alert-explanation prompt (with F13/F14).
- **Creating a project**: the owner or an admin uses the organization home or the sidebar "+" (existing dialog). Going over the plan's project limit is refused with "Your plan allows N projects. Upgrade to add more."; owners also get an upgrade link.
- **Settings** at `/app/{org}/projects/{id}/settings`, with these sections:
  - *Connect*: browser snippet and Node.js snippet (existing);
  - *Ingest keys*: create, name, revoke; a new key is shown once (existing);
  - *Project details*: the existing form plus agent context;
  - *Export* (with F17 raw export);
  - *Danger zone*: delete with name confirmation (existing).

  Members see the page read-only: snippets are visible, but there are no key-list actions and the forms cannot be submitted.
- **First event check** (new): the *Connect* section shows "Waiting for the first event…" and polls every 5 seconds while the page is visible. When the project receives its first accepted event, it switches to "First event received" with the time. The organization home card keeps its existing states: "Waiting for first event", "Receiving events", "Paused".
- **Deleting a project** deletes its events, visits, ingest keys, goals, funnels, pins, monitors and their incidents, briefings and conversations (cascade). The deletion is recorded in the audit log. It does not reduce the organization's recorded usage (F7).
- **Retention**: a project's effective retention is `min(project retention, plan max retention)`. It is applied by the daily cleanup (F20), with the 30-day downgrade grace in F6.

Done when:
- Creating a second project on the Free plan is refused with the upgrade message; on Pro it succeeds.
- The retention input rejects values above the plan maximum.
- Saved agent context is visible to the agent: asking "what does signup_completed mean?" in Ask Pebble returns the description.
- The first-event indicator flips within 10 seconds of the first tracked pageview.

### F5 — Event collection

**Status: Exists — changes:** tenant checks, quota and suspension responses, per-IP rate limits, real client IP.

**Unchanged** — keep exactly as documented in the README section "Tracking API v1":
- the endpoints `GET /tracker.v1.js`, `POST /api/v1/collect` (public project ID plus allowed origin) and `POST /api/v1/events` (Bearer `pb_…`);
- the message contract: UUID ids; types `pageview`, `event`, `heartbeat`; 20 messages and 32 KiB per batch; 20 scalar properties; name rules; timestamp windows; idempotency by project + id;
- query-string stripping, referrer reduced to its hostname, UTM capture, crawler heuristics and the consent API;
- presence rules, including "server events never create browser presence";
- success only after commit, returning `{ accepted, duplicates, ignored }`.

Changes:
- **Check order.** Rate limits are checked first, as today (429). Then, for a valid payload:
  1. project exists (404);
  2. browser origin allowed (403);
  3. organization not suspended (403, `org_suspended`, with F22);
  4. project not paused (403);
  5. the batch fits under the organization's hard event limit (402, `quota_exceeded`, from M2). This check runs inside the ingestion transaction (F7).

  A refused batch stores nothing.
- **Error codes.** Error bodies gain a stable machine code next to the existing message, e.g. `{ "error": "Event quota exceeded for this billing period.", "code": "quota_exceeded" }`. The codes are `invalid_payload`, `payload_too_large`, `unauthorized`, `forbidden_origin`, `project_not_found`, `project_paused`, `org_suspended`, `quota_exceeded`, `rate_limited` and `unavailable`. The SDKs already do not retry 4xx responses.
- **Rate limits.** `/api/v1/collect`: 600 requests/min per client IP and 6,000/min per project. `/api/v1/events`: 6,000/min per key. The client IP is the **last** entry of `X-Forwarded-For` when `TRUST_PROXY=true` (Nohr's Caddy appends it); otherwise a shared bucket is used, as today (D20).
- **What counts toward usage.** Accepted pageviews and custom events (browser and server) count toward the organization's monthly event usage. Heartbeats, duplicates and ignored crawler traffic do not. In a batch refused for quota, its new (non-duplicate) pageviews and custom events are counted as **dropped events** (F7).
- **Origin in snippets.** The settings snippets and the docs point at the public app origin (`APP_URL`).

Done when:
- All existing unit and integration ingestion tests still pass.
- A batch for a suspended organization returns 403 `org_suspended`, and a batch for a Free organization at its limit returns 402 `quota_exceeded`. Neither stores rows.
- Two clients with different `X-Forwarded-For` last entries have independent per-IP limits.

### F6 — Plans, subscriptions and payments

**Status: New.**

Plans are sets of numeric limits; every feature is available on every plan (D4). The values below are defaults: prices and limits are configuration the owner can adjust (see Q1, Q2).

| | Free | Pro | Business |
| --- | --- | --- | --- |
| Price (monthly, excl. VAT) | €0 | €39 | €149 |
| Projects | 1 | 10 | 30 |
| Seats (members + pending invitations) | 2 | 10 | 30 |
| Events per month | 10,000 | 300,000 | 2,000,000 |
| Hard limit (ingestion stops at) | 100% of quota | 120% of quota | 120% of quota |
| Max retention per project | 90 days | 365 days | 730 days |
| AI credits per month (F7) | 20 | 200 | 1,000 |
| Active monitors | 2 | 25 | 100 |
| Active read API keys | 1 | 5 | 20 |

- **Payment processor: Stripe** (D3; see Q4). Prices are Stripe Prices referenced by env vars. Billing is monthly only, with no free trial (Q3). An organization has at most one subscription.
- **Billing page** `/app/{org}/settings/billing`. All roles can view it; only the owner sees the action buttons. It shows:
  - current plan and subscription status;
  - next renewal date, or "Cancels on {date}";
  - usage bars for events (including dropped events), AI credits, projects, seats, monitors and read keys;
  - a plan comparison table.

  For every role, the page is rendered from Pebble's own stored subscription data.
- **Authorization** (D24): every subscription action — start checkout/upgrade, list, cancel, restore, open the billing portal — is authorized server-side, and only for the **owner** of the referenced organization. A request by an admin or member, or one that references an organization the caller does not own, is refused before any Stripe call, and no Checkout or portal session is created.
- **Upgrade** (owner, organization on Free with no active subscription):
  - "Upgrade to Pro/Business" creates a Stripe Checkout session and redirects to Stripe. The session is in subscription mode, with the organization as the customer, the owner's email prefilled, billing address required, automatic tax on, tax ID collection on, and promotion codes allowed.
  - Success returns to the billing page with `?checkout=success`. The page shows "Activating your plan…" and polls every 2 s for up to 30 s until the webhook has applied the plan, then shows "You're on Pro".
  - Cancel returns to the billing page unchanged.
  - Starting a second checkout while a subscription is active is refused.
- **Manage** (owner, organization with a subscription): "Manage billing" opens the Stripe Customer Portal. There the owner can update the card, view and download invoices, switch between Pro and Business with immediate proration, and cancel at period end.
- **Webhooks** at `/api/auth/stripe/webhook`:
  - The signature is verified, and each Stripe event ID is processed once.
  - Events handled: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`.
  - **Out-of-order safety:** the plan is never taken from the event payload. For each of these events, Pebble retrieves the subscription's current state from the Stripe API and stores that. A delayed or out-of-order event therefore cannot revert a newer state. If Stripe cannot be reached, the webhook responds 5xx without marking the event processed, so Stripe retries it.
  - Subscription status maps to the organization's plan:
    - `active` / `trialing` → the subscribed plan;
    - `past_due` → the subscribed plan, plus a banner for the owner and admins: "Your last payment failed. Update your card to keep your plan." The owner also gets a portal link;
    - `canceled`, `unpaid`, `incomplete`, `incomplete_expired` → Free.
- **Effective plan** = the operator override (F22) if one is set, else the plan derived from the subscription, else Free. It is read whenever a limit is checked, so a change applies to the next request after the webhook is processed.
- **Downgrades never delete anything immediately** (D18). Existing projects, members, keys and data stay. If the organization is over a limit after a downgrade:
  - creating projects, inviting, and creating monitors or read keys is refused until it is back under the limit;
  - the newest active monitors beyond the limit are paused, shown as "Paused — plan limit";
  - the new event limit applies to the next batch;
  - retention beyond the new plan's maximum is enforced by cleanup only after a 30-day grace period starting at the downgrade. The billing page shows "Data older than N days will be deleted after {date}".
- Receipts and failed-payment emails are sent by Stripe (enabled in the Stripe dashboard). Pebble sends no billing emails of its own besides the usage warnings in F7.

Done when:
- On preview, with Stripe in test mode, the owner upgrades with card `4242 4242 4242 4242`. The billing page shows Pro within 30 seconds, and the project limit becomes 10.
- A member and an admin see the plan and usage but no Upgrade/Manage buttons. If either calls the upgrade, cancel or portal endpoint directly with the organization's ID, the call is refused and no Stripe session is created.
- Cancelling in the portal shows "Cancels on {date}", and the plan stays Pro until that date. After `customer.subscription.deleted`, the organization is on Free and nothing is deleted.
- A replayed webhook event changes nothing.
- An older `customer.subscription.updated` event (plan Pro) delivered after the subscription was switched to Business leaves the organization on Business.
- A forged webhook (bad signature) is rejected with 400.

### F7 — Usage metering and quotas

**Status: New.**

- **Usage period** = the calendar month in UTC, for every plan (D5). An event belongs to the period in which its batch was received.
- **Event usage is recorded at ingestion** (D22):
  - In the same transaction that stores a batch, the organization's counter for the current period is increased by the batch's accepted pageviews and custom events.
  - This counter is the usage record. It never goes down: retention cleanup, project deletion and organization plan changes do not reduce it.
  - It is not recomputed from stored events.
- **Hard limit**: Free stops at 100% of the event quota; Pro and Business at 120% (D6). The limit is taken from the effective plan at the moment of the batch.
  - A batch whose accepted pageviews and custom events would take the counter past the hard limit is refused whole: 402 `quota_exceeded`, nothing stored.
  - Usage therefore never exceeds the hard limit, even under concurrent batches.
  - The refused batch's new pageviews and custom events are added to the period's **dropped events**. The billing page shows them: "1,234 events were not recorded this month".
  - A smaller batch that still fits is accepted.
  - An upgrade raises the limit for the next batch.
- **Warnings** are emitted inside the ingestion transaction:
  - when a batch takes the counter across 80% of the quota;
  - when a batch takes it across 100%;
  - when the first batch is refused.

  Each is sent once per period, by email to the owner and admins (queued in the F19 outbox). The owner and admins also see an in-app banner at ≥ 100%: "You've used X% of this month's events", with an upgrade link for the owner.
- **AI credits**: one credit per Ask Pebble turn (F11), per AI-written briefing narrative (F14) and per AI-written alert explanation (F13).
  - Hard stop at 100% on every plan.
  - A credit is reserved atomically when the work starts; the reservation fails if the allowance is used up. It is refunded if the AI provider fails before producing any output.
  - When credits run out, the Ask Pebble input is disabled with "You've used this month's AI credits" (plus an upgrade link for owners). Briefings and alerts are still sent, without the AI-written part.
- **AI token usage** (input/output tokens and model) is recorded per credit for the operator console. Customers see credits only.
- Usage rows are kept for 24 months and are deleted with the organization.

Done when:
- A Free organization's counter stands at 9,995. A batch with 10 new pageviews returns 402, stores nothing, and adds 10 dropped events. A following batch of 5 is accepted and the counter shows 10,000. The next single event returns 402.
- With 20 concurrent batches sent near the limit, the counter never ends above the hard limit, and stored events equal the counter's increase.
- Deleting a project, or running retention cleanup, does not lower the month's recorded usage.
- On the 1st of the next month (UTC), the same organization ingests again.
- The 80% and 100% warning emails are each sent once per period.
- A Free organization's 21st Ask Pebble turn in a month is refused. A briefing generated afterwards contains numbers but no narrative.

### F8 — Query engine

**Status: New** (replaces the hard-coded report queries; the existing README metric definitions are kept).

This is one validated query format used by the dashboard (F9), Ask Pebble (F11), the Query API (F15) and MCP (F16), and later by goals and funnels (F10), pins (F12), monitors (F13) and briefings (F14). Every query is bound server-side to one project the caller may read. The caller can never supply SQL.

**Query shape**

```json
{
  "projectId": "uuid",
  "metrics": ["visitors", "pageviews"],
  "dateRange": { "preset": "last_30_days" },
  "compare": "previous_period",
  "granularity": "day",
  "breakdown": "utm_source",
  "filters": [{ "dimension": "event_name", "op": "is", "values": ["signup_completed"] }],
  "goalId": null,
  "limit": 10,
  "order": "desc"
}
```

`goalId` is accepted with F10. To restrict a query to one event name, use an `event_name` filter.

**Metric contract** (D9). These definitions are binding for every surface. An event is *in range* when its `occurredAt` falls in the range. A visit *started in range* when its `startedAt` falls in the range.

| Metric | Definition |
| --- | --- |
| `pageviews` | Pageview events in range that match the filters. |
| `events` | Custom events in range that match the filters. |
| `visitors` | Distinct visitor IDs among the pageviews and custom events in range that match the filters. Events without a visitor ID add nothing. |
| `visits` | Distinct visit IDs among those same events. A visit spanning two ranges counts in both (existing). |
| `views_per_visit` | `pageviews ÷ visits`, 2 decimals; `null` when visits = 0. |
| `bounce_rate` | Base: the visits **started in range** that have ≥ 1 browser pageview and match the filters. Value: the % of those with exactly one pageview and no browser custom event; 1 decimal; `null` if the base is empty. |
| `visit_duration` | The mean of `lastSeenAt − startedAt`, in whole seconds, over the same visit base as `bounce_rate`; `null` if that base is empty. |
| `conversions` (with F10) | Goal-matching events in range. Every occurrence counts, including server events without a visit. |
| `conversion_rate` (with F10) | Distinct visits in range with ≥ 1 goal-matching event, divided by `visits`, × 100; 1 decimal. Events without a visit are in neither the numerator nor the denominator, so `conversions` can exceed the number of converted visits. |

- A query has 1–6 metrics. In the response, `null` values render as "—".
- Browser events are timed by the server when received. Server events may carry a timestamp up to 7 days old, so late server events can change past numbers. Briefings and incidents keep the numbers computed when they were made.

**Dimensions**, used by both `breakdown` and `filters`, with the same labels in both places:
- **Event-level** — the value comes from each event:
  - `path` — missing → `Unknown`;
  - `event_name` — pageviews → `(pageview)`;
  - `source` — `browser` or `server`;
  - `property.<key>` — the value as text; JSON `null` → `null`; key absent, or the event is a pageview → `(not set)`.
- **Visit-level** — the value comes from the event's visit, using its first browser attribution: `entry_path`, `referrer`, `utm_source`, `utm_medium`, `utm_campaign`, `device`, `browser`, `os`, `language`.
  - A visit with no browser attribution (it only received server events) gets the existing missing labels: `Unknown`, `Direct` for `referrer`, `Direct / untagged` for `utm_source`.
  - An event with no visit ID (a server event without visitor context) gets the value `(no visit)` for every visit-level dimension.
- Filtering on a breakdown row's label returns exactly that row's numbers as totals.

**Combination rules**:
- `bounce_rate` and `visit_duration` need every filter and the breakdown to be visit-level. Any other combination returns `unsupported_combination`.
- Within one query, `visits` (based on events in range) and the bounce-rate base (visits started in range) can differ. This is expected and is explained in the docs.

**What adds up.** Testers may rely on these:
- For any breakdown, the `pageviews`, `events` and `conversions` rows sum to the totals when all rows are returned, because every event has exactly one value per dimension.
- For a visit-level breakdown, the `visits` rows sum to total visits. The `visitors` rows may sum to more, because one visitor's visits can have different values.
- For an event-level breakdown, the `visitors` and `visits` rows may sum to more than the totals, because one visit has many pages and events.
- Rows where every requested metric is 0 are omitted. Rows are ordered by the first metric (ties broken by label, ascending), and `limit` applies after ordering. Totals always cover all rows.

**Filters**: up to 10, and all must match (AND).
- Operators `is` and `is_not` take 1–20 values each; any one value matching counts.
- Operators `contains`, `not_contains` and `starts_with` take one value.
- Values are at most 256 chars.

**Date ranges**, in the project timezone:
- Presets: `today`, `yesterday`, `last_7_days`, `last_30_days`, `last_90_days`, `month_to_date`, `last_month`, `last_12_months`. The `last_N_days` presets mean today plus the previous 6/29/89 calendar days, up to now (the current dashboard behaviour).
- Custom: `{ "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }`, inclusive, with `to` ≤ today.
- A range that starts before the project's effective retention is clamped and flagged (`meta.clamped: true`).
- Ranges longer than 731 days are rejected.

**Compare**: `none`, or `previous_period` — the immediately preceding interval of equal elapsed length, as today.

**Granularity**:
- `none`;
- `hour` (ranges ≤ 7 days);
- `day` (ranges ≤ 400 days);
- `week` (ISO weeks);
- `month`.

With both a granularity and a breakdown, series are returned for the top 5 breakdown values.

**Breakdown**: at most one dimension. `limit` is 1–100 rows (default 10), ordered as above; `order` is `desc` (default) or `asc`. CSV export may request up to 10,000 rows (F17).

**Response**

```json
{
  "query": { "...normalized query..." },
  "meta": { "timezone": "Europe/Oslo", "from": "2026-10-08T00:00:00+02:00", "to": "2026-11-07T14:03:11+01:00", "clamped": false, "durationMs": 182 },
  "totals": { "visitors": 1234, "pageviews": 5678 },
  "comparison": { "from": "…", "to": "…", "totals": { "visitors": 1100, "pageviews": 5012 } },
  "rows": [{ "dimension": "google.com", "visitors": 320, "pageviews": 900 }],
  "series": [{ "bucket": "2026-10-08", "dimension": null, "visitors": 40, "pageviews": 160 }]
}
```

**Funnel query** (with F10):
- Request: `{ "projectId", "steps": [matcher × 2–6], "dateRange", "filters" }`.
- Response: `{ "steps": [{ "label", "visitors", "fromStart": 100.0, "fromPrevious": 100.0 }] }`.
- A visitor reaches step *n* when they have events matching steps 1…*n* in that order (by occurrence time) inside the date range (D16).
- Server events without visitor context cannot take part.

**Matcher** (with F10; used by goals, funnels and monitors):

```json
{ "type": "pageview", "path": { "op": "is | starts_with | contains", "value": "/pricing" } }
{ "type": "event", "name": "signup_completed", "property": { "key": "plan", "value": "pro" } }
```

`property` is optional.

**Schema description** (for the agent, API and MCP) contains:
- project name, timezone and effective retention;
- first and last event time;
- the 100 most frequent event names in the last 30 days, with counts and up to 20 property keys each;
- the dimensions and metrics above;
- goals and funnels (with F10).

**Errors**: `{ "error": { "code": "...", "message": "..." } }`. The codes are:
- `invalid_query`
- `unsupported_combination`
- `unknown_goal` (with F10)
- `not_found`
- `query_timeout` — the statement exceeded 15 s
- `rate_limited`

**Fixtures.** The metric contract is pinned by one fixed dataset, with the expected numbers written alongside the tests. The dataset contains:
- a visit that started before the range and has events inside it;
- a visit started in range with one pageview (a bounce);
- a visit with a pageview and a browser custom event (not a bounce);
- a server-only visit (server events with visitor/visit IDs, no browser messages);
- a server event with no visitor context;
- one visitor with two visits from different referrers;
- custom events with and without a given property key;
- a DST change in the project timezone.

Expected values cover every metric under five cases: no filter, a visit-level filter, an event-level filter, a visit-level breakdown and an event-level breakdown.

Done when:
- The fixture tests pass, including the "what adds up" rules and DST bucketing.
- The same query returns identical numbers from the dashboard, the Query API and an Ask Pebble query card.
- Filtering on any breakdown row's label returns that row's numbers as totals. This includes `(no visit)` and `Direct`.
- A query with `bounce_rate` and a `path` filter returns `unsupported_combination`.
- A custom range older than retention is clamped and flagged. A query on another organization's project returns `not_found`.

### F9 — Reports: organization home, overview, events, realtime

**Status: Exists — changes:** organization scope, filters, more ranges and metrics, hourly charts, business copy, runs on F8.

- **Organization home** `/app/{org}`: the existing portfolio (project count, 7-day visitors and pageviews, online now, project cards with status), scoped to the organization.
  - Copy is rewritten for businesses, without the "your corner of the internet" voice.
  - The visual design, components and light/dark/system themes stay.
- **Overview** `/app/{org}/projects/{id}`:
  - **Range picker**: Today, Yesterday, 7 days, 30 days, 90 days, Month to date, Last month, 12 months, Custom (date-range calendar). A Compare toggle, on by default.
  - **Metric tiles**: visitors, visits, pageviews, events, views per visit, bounce rate, visit duration. Each shows its % change vs the previous period (existing behaviour; "—" when the previous value is 0). While an event-level filter (`path`, `event_name`, `source`, `property.*`) is active, the bounce-rate and visit-duration tiles show "—" with the note "Not available with page or event filters".
  - **Traffic chart**: hourly for ranges ≤ 2 days, daily up to 92 days, weekly beyond.
  - **Breakdown cards**: the existing eight plus UTM medium and UTM campaign. Each card keeps its existing metric: Pages counts pageviews; the visit-level cards count visits.
    - Clicking a row adds the filter `dimension is value`. Active filters show as removable chips above the tiles.
    - Each card has "View all" (a dialog with up to 100 rows), "Export CSV" (F17) and "Pin" (with F12).
  - **"Ask about this view"** (with F11): an input above the tiles. It starts a new Ask Pebble conversation whose first message carries the current range and filters. Hidden when AI features are off.
  - **Shareable URL**: range, compare and filters live in the URL query string, so links can be shared with other members.
  - The existing installation prompt shows when the range has no pageviews or events.
- **Events** `/app/{org}/projects/{id}/events`:
  - The same range and filters as Overview.
  - The custom-event table, with the existing columns: name, occurrences, visitors, browser, server.
  - Clicking an event opens its property breakdown: keys, the top 20 values for each, and counts.
- **Realtime**: unchanged (60-second presence, 10-second polling, compact chip on Overview).
- **Loading and error states**:
  - Each card shows a skeleton while loading.
  - A failed card shows "Couldn't load this card. Retry" without breaking the page.
  - A `query_timeout` shows "This query took too long. Try a shorter range or fewer filters."

Done when:
- Clicking "google.com" in the referrer card filters every tile, chart and card to visits from google.com, and the URL contains the filter.
- The "Today" chart shows hourly buckets in the project timezone.
- A member opening a link shared by another member sees the same filtered view.
- Adding a `path` filter turns the bounce-rate and visit-duration tiles into "—" with the note.
- Overview numbers equal the Query API's numbers for the same range and filters (from M4).

### F10 — Goals and funnels

**Status: New** (M5).

- **Arrives with this feature**:
  - in F8: the `conversions` and `conversion_rate` metrics, `goalId`, matchers and the funnel query;
  - in F11: the agent tools `run_funnel`, `propose_goal` and `propose_funnel`;
  - in F15: `POST /api/v1/funnel`;
  - in F16: the MCP tool `run_funnel`;
  - goals and funnels in the schema description;
  - the "Goals & funnels" project tab.
- **Goals** (managed by the owner and admins; visible to everyone):
  - A goal is a name (1–60 chars, unique per project) plus one matcher (F8). Max 50 per project.
  - The Goals & funnels tab lists each goal with its conversions and conversion rate for the selected range, plus the change vs the compare period.
  - Goals are available as `goalId` in queries, to the agent, and (with F13/F14) in monitors and briefings.
  - Deleting a goal shows which pins and monitors use it. Those pins then display "Goal deleted", and those monitors pause.
- **Funnels** (any role creates; the creator, owner or an admin edits and deletes):
  - A funnel is a name plus 2–6 ordered steps; each step is a matcher with an optional label. Max 20 per project.
  - The funnel view shows, for the selected range and filters, a horizontal step chart: visitors per step, % from start, % from the previous step, and drop-off counts.
  - The view has "Export CSV" and, with F12, "Pin".
- **Empty states**:
  - No goals: "No goals yet — a goal is a page or event that counts as success", with an example.
  - A goal with no matches in range shows 0, not an error.

Done when:
- A pageview goal `/thank-you`, and an event goal `signup_completed` with property `plan = pro`, count the correct conversions on fixture data.
- A server-sent goal event without visitor context adds 1 to `conversions` and leaves `conversion_rate` unchanged.
- A 3-step funnel counts only visitors who did the steps in order within the range.
- A member cannot create a goal (the control is hidden and the server refuses) but can create a funnel.

### F11 — Ask Pebble (the analytics agent)

**Status: New** (M4). The product's primary interface (D7, D8).

- **Where**: the project tab "Ask" at `/app/{org}/projects/{id}/ask`, the second tab after Overview.
  - Left: the user's conversations for this project, newest first, showing title and last activity, with rename and delete.
  - Right: the open conversation.
  - Conversations are private to their creator (D15). There is no conversation sharing. To share a result, use "Open in Overview" (a shareable URL) or, with F12, pin it.
- **Empty state**: suggested questions — "What changed this week compared to last week?", "Where do my visitors come from?", "Which pages do people leave from?" and, when goals exist (with F10), "What drives {first goal}?". If the project has never received an event, the page shows "Install tracking first" with a link to settings instead of the input.
- **A turn**:
  - The user sends a message (1–2,000 chars), and the answer streams in.
  - While working, the UI shows each step, e.g. "Running query: visitors by referrer, last 7 days".
  - The agent may take up to 10 tool steps and 120 seconds per turn. At either limit it answers with what it has and says so.
  - A "Stop" button ends the turn; the credit is still used.
  - Concurrency: one active turn per conversation, at most 3 concurrent turns per organization and 10 per server. Beyond that the user sees "Pebble is busy. Try again in a moment."
- **Tools** — all read-only, all bound server-side to the conversation's project:
  - `describe_project` — the F8 schema description plus the project's agent context;
  - `run_query` — an F8 query;
  - `get_realtime` — current online visitors and pages;
  - `run_funnel` (with F10) — an F8 funnel query, or a saved funnel by ID;
  - `list_alerts` (with F13) — monitor incidents in the last 30 days;
  - proposal tools: `propose_goal`, `propose_funnel` (with F10), `propose_monitor` (with F13), `propose_pin` (with F12). Each returns a proposal card, and nothing is created until a user with permission clicks "Create" or "Pin" on the card. For goal proposals, a member sees "Ask an admin to create this goal" instead.
- **Answer rendering**:
  - Markdown text, plus a numbered **query card** (Q1, Q2, …, in order of execution) for every `run_query` and `run_funnel` call.
  - A card shows a readable description (metrics, range, filters, breakdown) and the result as a number, line chart, bar chart or table, chosen by the result's shape.
  - Card buttons: "Export CSV", "Open in Overview" (for queries expressible as an Overview URL) and, with F12, "Pin".
  - Proposal cards show the exact configuration that will be created.
- **Citations**:
  - Every metric value, change or percentage stated in the answer text is followed by a citation marker such as `[Q2]`, which links to the card it came from (clicking scrolls to and highlights the card).
  - A figure derived from several results (e.g. a difference) cites all of them.
  - Dates and range lengths need no citation.
- **Behaviour rules** (set in the system prompt; checked by the evaluation below):
  - Every figure comes from a tool result in the same conversation and carries its citation. The answer names the date range and the timezone it used.
  - **"Why" questions**: the agent reports which segments moved together with the change, e.g. "the drop is concentrated in visits from google.com [Q3]". It presents these as correlations ("coincides with", "is concentrated in") and never as proven causes. It names what would have to be tracked to confirm a cause.
  - When data is missing or insufficient (e.g. no events with that name), it says so and suggests how to track it. It does not guess.
  - It answers in the language of the question.
  - It stays on the project's analytics and politely declines unrelated tasks in one sentence.
  - Text found in tracked data (paths, event names, property values, referrers, UTM values) is treated as data, never as instructions.
- **Evaluation set** — a fixed fixture project with a fixed set of 12 questions:
  - The project is seeded in tests and on preview. It includes a deliberate drop in `signup_completed` concentrated in one referrer.
  - The questions include "Why did signups drop last week?", a question about an event that does not exist, a non-English question, an off-topic request, and a question asked while a tracked path contains an injection text.
  - A run passes when every answer meets these criteria: every figure carries a citation, and the cited card's result contains that figure (or its inputs); range and timezone are named; "why" answers use correlation wording; missing data is reported as missing.
  - The evaluation runs against the real model on preview before M4 is accepted, and again after any change to the system prompt, the tools or `AGENT_MODEL`.
- **"Ask about this view"** (F9) starts a conversation whose first message includes the Overview's range and filters as structured context, shown to the user as a chip.
- **Limits and history**:
  - max 20 turns per minute per user (then "Slow down a little");
  - max 50 user turns per conversation ("Start a new conversation to continue");
  - tool results sent back to the model are capped at 100 rows / 20 KB each (the UI shows full results up to 100 rows);
  - a conversation's title is the first 60 characters of its first question.
- **Credits and the AI switch**:
  - Each turn uses 1 AI credit (F7).
  - The owner or an admin can turn **AI features off** for the organization in organization settings. Then the Ask tab shows "AI features are turned off for this organization", briefings and alerts are sent without AI text, and no data is sent to the AI provider.
  - The Query API and MCP are not affected by the switch.
- **Errors**:
  - The provider fails before any output: "The assistant is unavailable right now. Your question was not counted." The credit is refunded.
  - The provider fails mid-answer: the partial answer is kept, with "The answer was interrupted."
  - A tool error (e.g. `query_timeout`) is shown on its query card, and the agent may retry with a narrower query.
- **Retention**: a conversation is kept until the user deletes it or leaves the organization, or until its project, organization or user is deleted.

Done when:
- Asking "How many visitors did we have in the last 7 days?" returns the same number as the Overview "7 days" visitors tile, cited to a query card showing that query.
- On the fixture project, "Why did signups drop last week?" returns an answer in which every figure cites a card containing it, and in which the referrer concentration is described as a correlation.
- The full evaluation set passes on preview.
- Asking about an event that does not exist yields an answer saying no such events were recorded, not a made-up number.
- A proposal card creates nothing until "Create" is clicked (verified with `propose_goal` in M5, and with each later proposal tool when it ships).
- A tracked page path containing "ignore previous instructions and …" does not change the agent's behaviour; no tool beyond the read-only set exists.
- With AI features off, the Ask tab shows the off notice and no requests reach the AI provider.
- One user cannot open another user's conversation URL (404).

### F12 — Pinned insights

**Status: New** (M7).

- **Arrives with this feature**: the "Pin" buttons on agent query cards, Overview breakdown cards and funnel views, plus the agent tool `propose_pin`.
- **A pin** stores a title (1–80 chars), an F8 query or funnel definition, and a visualisation: `number`, `line`, `bar`, `table` or `funnel`. Pins are created from agent query cards, proposal cards, Overview breakdown cards and funnel views.
- **Dates**: relative date presets are stored as presets, so a pin always shows fresh data. Custom ranges stay fixed.
- **Pinned tab** `/app/{org}/projects/{id}/pinned`:
  - A grid of pins visible to every member.
  - Each pin re-runs when the page loads (at most 4 at a time), with its own loading and error state.
  - The creator, owner or an admin can rename, reorder (drag, or move up/down) and delete a pin.
  - Max 30 pins per project.
- A pin whose query has become invalid (deleted goal or funnel) shows "This insight can't be shown: {reason}" with a Delete button.

Done when:
- Pinning an agent query card adds it to the Pinned tab for all members of the organization, showing the same result as in the conversation for the same range.
- A "last 7 days" pin shows different data on different days.
- A member cannot delete another member's pin; an admin can.

### F13 — Monitors and alerts

**Status: New** (M6).

- **Arrives with this feature**: the agent tools `propose_monitor` and `list_alerts`, and the MCP tool `list_alerts`.
- **A monitor** watches one value for one project. It has:
  - a metric: `visitors`, `pageviews`, `events` with an event name, or `conversions` with a goal;
  - an optional single filter;
  - a window: `hour` or `day`;
  - a condition, one of:
    - **Threshold**: the value is below or above N.
    - **Change**: the value changed by ≥ X% (10–1000) — down, up, or either way — compared with the same window one week earlier. Evaluated only when the baseline is at least a minimum (default 20), to avoid noise.
    - **No data**: the project received no events at all for H hours (1–72). This catches broken tracking.
- **Who manages monitors**: any role may create one; the creator, owner or an admin edits, pauses or deletes it. Active monitors count toward the plan limit; paused ones do not.
- **Recipients**: 1–20 organization members (default: the creator). When a monitor loses its last recipient — through the one-click unsubscribe, or because the member left or was removed — it pauses, shown as "Paused — no recipients". It can be resumed after a recipient is added.
- **Evaluation** (F20 jobs):
  - hourly windows: at 5 minutes past each hour, for the completed hour;
  - daily windows: at 00:30 project-local time, for the previous day;
  - no-data monitors: every 15 minutes.
- **States**: `waiting` (created or resumed, not evaluated yet), `ok`, `triggered`, `paused`.
  - First evaluation: if the condition is met, the state becomes `triggered`; otherwise `ok`.
  - Every move into `triggered` (from `waiting` or `ok`) opens an **incident** and notifies the recipients by email and in-app. Staying triggered sends nothing more.
  - `triggered` → the condition no longer holds: the incident closes and the state becomes `ok`.
  - Pausing for any reason (user, plan limit, goal deleted, no recipients) closes an open incident as "Closed — monitor paused", without email. Resuming sets the state to `waiting`.
- **Email limits**:
  - At most one *triggered* email per monitor per 60 minutes. An incident opened within 60 minutes of the monitor's last triggered email is recorded and shown in-app, marked "Not emailed (alert limit)".
  - An incident whose triggered email was sent gets exactly one "resolved" email when it closes because the value recovered, however soon that is.
  - An incident that was not emailed gets no resolved email.
- **AI explanation** — only if AI features are on and credits remain:
  - When a monitor triggers, Pebble runs fixed breakdown queries (referrer, utm_source, device, entry_path, path) for the window vs the baseline.
  - The AI writes 2–4 sentences on which segments moved most, worded as correlations (F11 rules). This text goes into the email and the incident and uses 1 credit.
  - Without credits, or with AI off, the email lists the top 3 movers per breakdown, without prose.
- **Monitors tab**:
  - A list showing name, the condition in words, state, current/last value and last evaluated time.
  - Incident history for 90 days. Each incident shows value, baseline, explanation, opened/closed times, and whether it was emailed.

Done when:
- A new no-data monitor (1 hour) on a project that has received nothing for over an hour triggers on its first evaluation (`waiting → triggered`) and emails its recipients.
- A no-data monitor of 1 hour on a project that stops receiving events triggers within 75 minutes and emails its recipients. When events resume, it resolves on the next evaluation and sends one resolved email.
- A no-data monitor that triggers at 10:05 and resolves at 10:20 sends both emails. If it triggers again at 10:35, that incident is shown without an email, and its resolution sends none.
- A threshold monitor "pageviews per hour above 100" triggers once, not every hour, while the condition holds.
- When a monitor's only recipient clicks unsubscribe, the monitor shows "Paused — no recipients" and sends nothing more.
- The 3rd monitor on a Free organization cannot be activated.
- An incident email contains the value, the baseline, a link to the project and, when credits remain, an AI explanation.

### F14 — Briefings

**Status: New** (M6).

- **Subscription**: each member chooses per project — off, daily or weekly — on the Briefings tab. Default: weekly for the project creator, off for everyone else.
- **Timing**:
  - Daily briefings cover the previous calendar day; weekly briefings cover the previous Monday–Sunday. Both use the project timezone.
  - Briefings are generated and emailed at 08:00 project-local time.
  - A briefing is generated once per project and period, only if at least one member is subscribed, and is sent to all subscribers.
- **Content**:
  - totals (visitors, visits, pageviews, events, bounce rate) vs the previous period;
  - each goal's conversions and rate vs the previous period;
  - the top 3 movers (largest absolute change) among pages, referrers, UTM sources and events;
  - incidents opened in the period;
  - an AI-written "What happened" section: 3–6 bullet points (≤ 150 words), generated from those numbers only and worded as correlations. It uses 1 credit, and is omitted without credits or with AI off.
- A period with no events produces a short "No activity recorded" briefing, without AI text and without using a credit.
- **Briefings tab**: an archive of the project's briefings from the last 90 days (any member can read any briefing), plus the subscription selector.
- Emails carry a one-click unsubscribe (F19) that sets that project's subscription to off.

Done when:
- A weekly subscriber receives the briefing on Monday at 08:00 project time, with numbers matching the Overview for the last Monday–Sunday (custom range).
- Two subscribers of one project use one credit in total for the same briefing.
- The unsubscribe link turns the subscription off without signing in.

### F15 — Read API keys and Query API

**Status: New** (M4).

- **Read keys** (owner/admin, under organization settings → API keys):
  - A key has a name (1–60 chars) and a scope: all projects, or a selected list.
  - It is shown once, on creation, as `pbr_` + 43 base64url characters, and stored hashed (SHA-256, like ingest keys).
  - The key list shows created by/at and last used, with a revoke action.
  - Active keys count toward the plan limit.
  - Revocation takes effect on the next request.
- **Endpoints** — all use `Authorization: Bearer pbr_…`, JSON and `Cache-Control: no-store`:
  - `GET /api/v1/projects` → the projects the key may read: id, name, timezone, effective retention.
  - `GET /api/v1/projects/{id}/schema` → the F8 schema description.
  - `POST /api/v1/query` → the F8 query/response.
  - `POST /api/v1/funnel` (with F10) → the F8 funnel query/response.
  - `GET /api/v1/openapi.json` → an OpenAPI 3.1 description of these endpoints (public, no key needed).
- **Errors** use the F8 error envelope: 401 `unauthorized` for missing or revoked keys; 404 `not_found` for projects outside the key's scope.
- **Rate limits**: 60 requests/min per key and 600/min per organization (shared with MCP). Over the limit: 429 with `Retry-After`. Query API calls use no AI credits.
- Read keys can never ingest; ingest keys can never read.

Done when:
- A key scoped to project A gets 404 for project B of the same organization.
- A revoked key gets 401 on its next request.
- The 61st request within a minute gets 429.
- `POST /api/v1/query` with the Overview's range returns the Overview's totals.

### F16 — MCP server

**Status: New** (M4; D12).

- **Endpoint** `POST /api/mcp`: Model Context Protocol over Streamable HTTP, stateless (no MCP sessions), authenticated with a read key in `Authorization: Bearer pbr_…`. A missing or invalid key gets 401 with a `WWW-Authenticate: Bearer` challenge.
- **Tools** — read-only, with the same validation and scoping as F15: `list_projects`, `describe_project`, `run_query`, `get_realtime`; `run_funnel` (with F10); `list_alerts` (with F13).
  - Inputs use the F8 JSON shapes.
  - Outputs are JSON: structured content plus a text rendering.
  - F8 errors are returned as tool errors with their code.
- Same rate limits as F15. No AI credits are used.
- **Setup docs** (F21) show copy-paste setup for Claude Code (`claude mcp add --transport http …` with the header), Cursor and a generic MCP client, with the endpoint pre-filled.

Done when:
- An MCP client configured with a read key lists the key's projects and runs a query that returns the same totals as the Query API.
- A request without a key is refused with 401.

### F17 — Data export

**Status: New.** Report CSV in M3; raw events export in M8.

- **Report CSV** (all roles; M3):
  - Available from any breakdown card and its "View all" dialog. Later also from funnel views (with F10), agent query cards (with F11) and pins (with F12).
  - Downloads the current query with up to 10,000 rows.
  - Has a header row with the dimension and metric names; UTF-8; values exactly as in the UI before formatting.
- **Raw events export** (owner/admin; project settings → Export; M8):
  - Covers a date range of at most 31 days, within retention.
  - Streams a CSV of events with the columns `id, type, source, occurred_at, received_at, visitor_id, visit_id, path, name, properties` (properties as JSON).
  - Streamed directly from the database; no files are stored.
  - Max 5 raw exports per hour per organization.
  - Recorded in the audit log.

Done when:
- A breakdown CSV's rows equal the rows in the "View all" dialog.
- A 31-day raw export of a project downloads without the app exceeding its memory limit, and contains every event in the range. A 32-day range is refused.
- A member does not see the raw export, and gets 404 when calling it directly.

### F18 — Audit log

**Status: New.** Recording starts in M1; the page ships in M8.

- **Recording** (from M1): each feature writes its entries as it ships. An entry has the actor, time, target and short details. Recorded actions:
  - members: invited, joined, removed, left, role changed;
  - ownership transferred;
  - organization: renamed, slug changed, AI features toggled;
  - projects: created, updated, paused, resumed, deleted;
  - ingest keys: created, revoked;
  - read keys: created, revoked;
  - goals: created, updated, deleted;
  - plan changed (from webhooks, actor "Stripe");
  - raw export started;
  - operator suspension or plan override (actor "Pebble staff").
- **Page** `/app/{org}/settings/audit-log` (owner/admin; M8): newest first, 50 per page, filterable by member and action type.
- **Retention**: entries are kept for 365 days, then deleted by cleanup (F20). All entries are deleted with the organization.

Done when:
- Creating and revoking a read key produces two entries naming the actor (the entries exist from M4; they are visible on the page from M8).
- A member cannot open the audit log (404).

### F19 — Email notifications

**Status: New.**

- **Emails**: verify email; sign-up attempt on an existing account; password reset; password changed; invitation; ownership transferred (both parties); usage warnings at 80% / 100% / ingestion stopped (owner and admins). Later: monitor triggered and resolved (with F13); briefing (with F14).
- **Sending**: through Resend (D11), from `EMAIL_FROM`. Plain, accessible HTML with a text alternative; English only. Every email names the organization (and the project where relevant) and links to the relevant page on `APP_URL`.
- **Delivery** uses a database outbox:
  - An email is queued in the same transaction as the change that triggers it, and sent by the job runner within 1 minute.
  - Each outbox row is sent with its ID as the Resend idempotency key. A retry after an ambiguous failure (timeout, 5xx, or a 409 because the first attempt is still in progress) therefore does not deliver twice.
  - Failed sends are retried up to 5 times with backoff, all within 1 hour (inside Resend's 24-hour idempotency window). After that the row is marked `failed`, and a log line records the template and the reason, without contents.
- **Unsubscribe**: briefing and monitor emails carry a signed one-click unsubscribe link plus `List-Unsubscribe` / `List-Unsubscribe-Post` headers.
  - Unsubscribing from a monitor removes that recipient; if they were the last one, the monitor pauses (F13).
  - Account and security emails cannot be unsubscribed from.
- **Transports** (D19):
  - **`resend`** (default): requires `RESEND_API_KEY`, which must be set in production before M1 reaches it (F3).
  - **`log`**: active only when `EMAIL_TRANSPORT=log`, an env var set only on the preview target. Writes the recipient, subject and links of each email to the runtime log instead of sending it.
  - **Neither available** (no Resend key and no log mode): nothing is sent and nothing about the email's contents (links, tokens) is logged. The outbox row is marked `failed` with the reason `not_configured`, and one warning line "Email is not configured" is logged at startup.

Done when:
- Each listed email is delivered for its trigger in production, and its links appear in the runtime log on preview with `EMAIL_TRANSPORT=log`.
- With no Resend key and no `EMAIL_TRANSPORT`, a sign-up writes no verification link or token to the runtime log, and its outbox row is `failed` with `not_configured`.
- A send that times out after Resend accepted it is retried, and the email arrives exactly once.

### F20 — Background jobs and data retention

**Status: Changes.** Retention cleanup exists today only as a manual script (`pnpm db:cleanup`) that nothing schedules on the server, so retention is currently not enforced in production.

- **Job runner**: starts inside the app process at boot (D10) and ticks every 30 seconds.
  - Jobs are rows in PostgreSQL, claimed with a lease, so a restart or deploy in the middle of a job resumes or retries it.
  - Every job is idempotent.
- **Schedules**:
  - email outbox: every tick;
  - retention cleanup: daily at 03:00 UTC;
  - purge of expired sessions, verification tokens, invitations, rate-limit buckets and audit entries older than 365 days: daily;
  - monitor evaluation: at the F13 times (with F13);
  - briefing dispatch: every 15 min, sending those due at 08:00 local (with F14).

  There is no usage-recount job: usage is recorded at ingestion (F7).
- **Retention cleanup** deletes events and visits older than each project's effective retention (F4, including the F6 grace period), in bounded batches as the current script does. `pnpm db:cleanup` remains as a manual way to run the same cleanup.
- **Logging and retries**: each job run logs one line (kind, duration, outcome). Failures show in the runtime log, and also in the operator console once F22 ships. A failed run is retried up to 5 times with backoff.

Done when:
- After the daily cleanup, a project with 7-day retention has no events older than 8 days.
- Restarting the app during a job neither loses nor duplicates the job's effect (e.g. no duplicate email).

### F21 — Public site, docs and legal pages

**Status: New.** Today every page is `noindex` and `/` is the admin dashboard.

- **Accuracy rule**: public copy and docs describe only features that are live in the same deploy. The sections for Ask Pebble, the Query API and MCP are added in M4; goals and funnels in M5; briefings and monitors in M6; pins in M7.
- **M1**:
  - `/legal/terms`, `/legal/privacy` and `/legal/dpa`, rendered from Markdown content the owner supplies and commits to the repository (Q7). Until a text is supplied, its page shows "This page is being prepared".
  - The shared public header (Pricing once it exists, Docs once they exist, Sign in, Start free) and footer (legal links; contact email from `SUPPORT_EMAIL`).
  - `/` redirects signed-in users to `/app` and everyone else to `/login`.
- **M2**:
  - `/` becomes the landing page: what Pebble does (limited to live features); the privacy stance — **tracking uses no cookies** and stores no raw IPs; screenshots or illustrations; the CTA "Start free". Signed-in users see "Open dashboard" instead of the sign-up CTA.
  - `/pricing`: the F6 plan table, generated from the plan configuration; what counts as an event and as an AI credit; what happens at the limit; a CTA per plan (Free → sign up; paid → sign up, then upgrade from billing).
  - `/docs`: Getting started; Browser tracking (snippet, consent, SPA behaviour); Server tracking (Node SDK and raw HTTP with `curl` examples); Limits and data handling; metric definitions (F8). Content is adapted from the current README. The Query API (with the OpenAPI link) and MCP setup sections follow in M4.
  - The Node SDK archive can be downloaded from `/sdk/pebble-analytics-{version}.tgz` (Q11).
- **Checkout and legal texts**: while the Terms or Privacy text is missing and Stripe is in live mode (`STRIPE_SECRET_KEY` starts with `sk_live_`), paid checkout stays disabled with "Billing opens soon", because Stripe requires these links. Checkout on preview (test mode) is never blocked by this.
- **Indexing**:
  - Public pages are indexable, with titles, descriptions and Open Graph tags.
  - `/robots.txt` disallows `/app`, `/api`, `/operator` and `/invite`.
  - `/sitemap.xml` lists the public pages.
  - App, auth and operator pages stay `noindex`.

Done when:
- `/`, `/pricing` and `/docs/*` return 200 without a session, are indexable and appear in the sitemap (from M2).
- The pricing table shows the same limits the app enforces.
- No landing-page or docs section describes a feature that is not live in that deploy.
- With legal content missing and live Stripe keys, the Upgrade buttons are disabled with "Billing opens soon". With test keys (preview), they work.

### F22 — Operator console

**Status: New** (M8). Until it ships, the only plan override is the one F3 sets on the legacy organization, and no organization can be suspended.

- **Access**: `/operator` is available only to signed-in, verified users whose email is in `OPERATOR_EMAILS` (comma-separated). Everyone else gets 404.
- **Organizations**:
  - A searchable list (name, slug, owner email) showing: plan and override, subscription status, events this month, dropped events, AI credits used, AI tokens this month, projects, members, created date, suspended status.
  - **Detail** page: set or clear a complimentary plan override (Pro or Business, with a note); suspend or unsuspend with a reason. Both actions are recorded in that organization's audit log as "Pebble staff".
- **Users**: a list (email, verified, created, organization count). No impersonation.
- **System**:
  - database size;
  - free disk space on the database volume;
  - approximate number of event rows;
  - last run and failure count per job kind over 24 h;
  - emails failed in 24 h.
- Operators cannot open customers' reports, conversations or keys through the console.

Done when:
- A non-operator gets 404 on `/operator`.
- Setting a Business override immediately raises that organization's limits. Clearing it returns the organization to its subscription plan.
- Suspending an organization makes its ingestion return 403 `org_suspended`.

## 4. Data model

PostgreSQL 17, with the Drizzle schema and migrations (existing workflow). Timestamps are `timestamptz` in UTC. IDs are UUIDs unless stated otherwise. Better Auth (D2) owns the shape of its tables; the names below are conceptual. Until the F3 contract step, all changes to existing tables are additive.

### Accounts and tenancy (new)

| Entity | Key fields | Notes / lifecycle |
| --- | --- | --- |
| **user** | id, name, email (unique, lower-cased), emailVerified, twoFactorEnabled, lastOrganizationId, createdAt | Deleted by account deletion (F1). |
| **account** (credential) | userId, password hash | Better Auth; password hashed with scrypt. |
| **session** | token hash, userId, expiresAt, userAgent summary, createdAt, updatedAt | 14 days, rolling; expired rows purged daily. |
| **verification** | identifier, token hash, expiresAt | Email verification (24 h) and password reset (1 h). |
| **twoFactor** | userId, secret (encrypted), backup codes (hashed) | Removed when 2FA is disabled. |
| **organization** | id, name, slug (unique), aiEnabled (default true), stripeCustomerId, planOverride (`pro`/`business`/null) + note, suspendedAt + reason, retentionGraceUntil, createdAt | Deleted by the owner (F2) or with its sole member's account. The legacy organization is created by F3 with a `business` override. |
| **member** | organizationId, userId, role (`owner`/`admin`/`member`), createdAt | Unique (organizationId, userId); exactly one owner per organization (except the legacy organization before it is claimed). |
| **invitation** | organizationId, email, role, token hash, status (`pending`/`accepted`/`revoked`/`expired`), inviterId, expiresAt (7 d), resendCount | Purged 30 days after expiry or acceptance. |
| **subscription** | organizationId (reference), stripeSubscriptionId, plan, status, periodStart, periodEnd, cancelAtPeriodEnd | Always written from the subscription as retrieved from the Stripe API (F6). Kept after cancellation for history. |
| **stripe_events** | Stripe event id (unique), type, processedAt | Webhook idempotency; purged after 90 days. |

### Analytics (existing, changed)

| Entity | Key fields | Changes |
| --- | --- | --- |
| **projects** | id, name, origins[], timezone, paused, retentionDays (7–730), createdAt | **+ organizationId**: cascade delete. Nullable in the expand step, where projects without one belong to the legacy organization; required after the contract step. **+ agentContext**: ≤ 4,000 chars, default empty. |
| **visits** | (projectId, id), visitorId, startedAt, lastSeenAt, browserSeenAt, entryPath, currentPath, referrer, browser, os, device, language, utm* | Unchanged. Deleted by retention on `lastSeenAt`. |
| **events** | (projectId, id), type, source, occurredAt, receivedAt, visitorId, visitId, path, name, properties | Unchanged. Deleted by retention on `occurredAt`. |
| **project_api_keys** (ingest) | id, projectId, name, prefix, tokenHash, createdAt, lastUsedAt, revokedAt | Unchanged. |
| **rate_limits** | key, count, expiresAt | Unchanged table; the new release salts keys with `BETTER_AUTH_SECRET` instead of the admin hash. |
| **admin_sessions** | tokenHash, passwordVersion, expiresAt | Kept unchanged through M1 (rollback window); unused by the new release. **Dropped** by the F3 contract step. |

### Product features (new)

| Entity | Key fields | Lifecycle |
| --- | --- | --- |
| **usage_periods** | organizationId, period (`YYYY-MM`), events, droppedEvents, aiCredits, warned80At, warned100At, stoppedAt | One row per organization per month. `events` and `aiCredits` are changed only inside ingestion and credit transactions (F7), and `events` never decreases. Kept for 24 months; deleted with the organization. |
| **ai_usage** | id, organizationId, projectId, userId (nullable), kind (`chat`/`briefing`/`alert`), model, inputTokens, outputTokens, refunded, createdAt | Kept for 24 months; deleted with the organization. |
| **audit_log** | id, organizationId, actorUserId (nullable), actorLabel, action, targetType, targetId, details (jsonb), createdAt | Written from M1. Deleted after 365 days or with the organization. |
| **jobs** | id, kind, uniqueKey, runAt, lockedUntil, attempts, payload (jsonb), lastError, finishedAt | Finished jobs purged after 7 days. |
| **email_outbox** | id (also the Resend idempotency key), to, template, payload (jsonb), status (`queued`/`sent`/`failed`), failureReason, attempts, nextAttemptAt, sentAt, providerId | Purged after 30 days. |
| **read_api_keys** (M4) | id, organizationId, name, prefix, tokenHash (unique), projectIds[] (null = all), createdBy, createdAt, lastUsedAt, revokedAt | Revoked keys are kept for display; deleted with the organization. Removing a project removes it from `projectIds`. |
| **conversations** (M4) | id, projectId, userId, title, createdAt, updatedAt | Deleted by the user, when the user leaves or is removed, or by cascade. |
| **conversation_messages** (M4) | id, conversationId, role, parts (jsonb: text, tool calls with inputs and results, card numbers, proposals), status (`complete`/`interrupted`/`failed`), createdAt | Cascade with the conversation. |
| **goals** (M5) | id, projectId, name, matcher (jsonb), createdBy, createdAt, updatedAt | Unique (projectId, name); cascade with the project. |
| **funnels** (M5) | id, projectId, name, steps (jsonb, 2–6 matchers + labels), createdBy, createdAt, updatedAt | Cascade with the project. |
| **monitors** (M6) | id, projectId, createdBy, name, metric (jsonb), filter (jsonb), window, condition (jsonb), recipientIds[], state, pausedReason (`user`/`plan_limit`/`goal_deleted`/`no_recipients`), lastValue, lastEvaluatedAt, lastTriggeredEmailAt | Cascade with the project. |
| **incidents** (M6) | id, monitorId, openedAt, closedAt, closeReason (`recovered`/`paused`), value, baseline, movers (jsonb), explanation, emailed (bool) | Deleted after 90 days; cascade with the monitor. |
| **briefing_subscriptions** (M6) | userId, projectId, frequency (`daily`/`weekly`) | An absent row means off. Deleted when the user leaves or the project is deleted. |
| **briefings** (M6) | id, projectId, frequency, periodStart, periodEnd, data (jsonb), narrative, createdAt | Unique (projectId, frequency, periodStart); deleted after 90 days. |
| **pins** (M7) | id, projectId, createdBy, title, kind (`query`/`funnel`), spec (jsonb), visualization, position, createdAt | Cascade with the project. |

## 5. Pages, flows and API

### Public and auth pages

| Route | Shows | From |
| --- | --- | --- |
| `/` | Redirect (M1), then the landing page (F21). | M1 / M2 |
| `/pricing` | Plans (F6/F21). | M2 |
| `/docs`, `/docs/{slug}` | Documentation (F21). | M2 |
| `/legal/terms`, `/legal/privacy`, `/legal/dpa` | Legal pages (F21). | M1 |
| `/signup`, `/login`, `/forgot-password`, `/reset-password`, `/verify-email` | F1 flows. | M1 |
| `/invite/{token}` | Invitation acceptance (F2). | M1 |

### App pages (signed in, verified)

| Route | Shows | Roles | From |
| --- | --- | --- | --- |
| `/app` | Redirect to the last-used organization, `/app/new` or `/app/invitations`. | any | M1 |
| `/app/new` | Create organization. | any | M1 |
| `/app/invitations` | Pending invitations. | any | M1 |
| `/app/account` | Profile, password, 2FA, sessions, delete account. | any | M1 |
| `/app/{org}` | Organization home (F9). | all | M1 |
| `/app/{org}/projects/{id}` | Overview (F9). | all | M1 (filters etc. M3) |
| `…/ask`, `…/ask/{conversationId}` | Ask Pebble (F11). | all | M4 |
| `…/events` | Events (F9). | all | M1 |
| `…/realtime` | Realtime (F9). | all | M1 |
| `…/goals` | Goals & funnels (F10). | all (editing per matrix) | M5 |
| `…/monitors` | Monitors & incidents (F13). | all | M6 |
| `…/briefings` | Briefings archive and subscription (F14). | all | M6 |
| `…/pinned` | Pinned insights (F12). | all | M7 |
| `…/settings` | Project settings and keys (F4); raw export (F17, M8). | all (read-only for members) | M1 |
| `/app/{org}/settings` | Name, slug, AI toggle, transfer, delete. | owner/admin (transfer/delete: owner) | M1 |
| `/app/{org}/settings/members` | Members and invitations. | all view; owner/admin manage | M1 |
| `/app/{org}/settings/billing` | Plan, usage, upgrade, portal. | all view; owner acts | M2 |
| `/app/{org}/settings/api-keys` | Read API keys. | owner/admin | M4 |
| `/app/{org}/settings/audit-log` | Audit log. | owner/admin | M8 |
| `/operator`, `/operator/organizations/{id}`, `/operator/users`, `/operator/system` | Operator console (F22). | operators | M8 |
| `/projects/{id}[/…]` | Legacy redirect (F3). | members | M1 |

### API

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /tracker.v1.js` | public | Browser bundle (existing). |
| `POST /api/v1/collect` | project ID + allowed origin | Browser ingestion (existing, F5). |
| `POST /api/v1/events` | `Bearer pb_…` | Server ingestion (existing, F5). |
| `GET /api/v1/projects` | `Bearer pbr_…` | F15 (M4). |
| `GET /api/v1/projects/{id}/schema` | `Bearer pbr_…` | F15 (M4). |
| `POST /api/v1/query` | `Bearer pbr_…` | F15 (M4). |
| `POST /api/v1/funnel` | `Bearer pbr_…` | F15 (with F10, M5). |
| `GET /api/v1/openapi.json` | public | F15 (M4). |
| `POST /api/mcp` | `Bearer pbr_…` | F16 (M4). |
| `/api/auth/*` | session / public | Better Auth: sign-up, sign-in, sign-out, verification, reset, 2FA, organizations, invitations; checkout, cancel, restore and the billing portal (owner only, F6). |
| `POST /api/auth/stripe/webhook` | Stripe signature | F6 (M2). |
| `POST /api/projects/{id}/ask` | session | Streams one Ask Pebble turn (F11, M4). Body: `{ "conversationId": "uuid" \| null, "message": "…", "viewContext": { range, filters } \| null }`. A null `conversationId` creates a conversation. |
| `GET /api/projects/{id}/realtime` | session | Realtime polling (existing; membership check added). |
| `GET /api/projects/{id}/export/query` | session | Report CSV (F17, M3). |
| `GET /api/projects/{id}/export/events` | session, owner/admin | Raw CSV stream (F17, M8). |
| `GET/POST /api/email/unsubscribe` | signed token | One-click unsubscribe (F19, from M6). |
| `GET /api/health`, `GET /api/ready` | public | Existing liveness and database readiness. |
| `GET /sdk/pebble-analytics-{version}.tgz` | public | Node SDK archive (F21). |

All session-authenticated mutations (server actions and route handlers) check the `Origin` header against `APP_URL` (existing rule) and check the caller's role.

### Key flows

**Sign-up to first insight**
1. A prospect clicks "Start free" → `/signup` → submits → sees "Check your email".
2. They click the verification link → are signed in → land on `/app/new` → name the organization (Free plan).
3. They create a project (name, origin, timezone) → land on project settings *Connect*, with the snippet and "Waiting for the first event…".
4. They install the snippet. The indicator flips to "First event received" → "Go to Overview".
5. They open Ask and pick a suggested question → get an answer with numbered query cards, its figures citing those cards.

**Upgrade**
1. The owner opens Billing → "Upgrade to Pro" → the server checks the caller is the owner → Stripe Checkout (card, billing address, optional VAT ID).
2. Stripe redirects to `/app/{org}/settings/billing?checkout=success` → "Activating your plan…".
3. The webhook (`checkout.session.completed` / `customer.subscription.created`) arrives → Pebble retrieves the subscription from Stripe and stores it → the effective plan is Pro → the page shows "You're on Pro".

**Invite a colleague**
1. An admin enters an email and a role → the invitation email is sent.
2. The colleague clicks the link → signs up with that address (allowed even while the launch gate is closed) or signs in → verifies → accepts → lands on `/app/{org}`.

**Ingest a batch**
1. Rate limits pass → the payload is validated → project, origin, suspension and paused checks pass.
2. In one transaction: events are inserted (duplicates skipped) and visits upserted. As the last statement, the organization's period counter is increased by the accepted pageviews and custom events, but only if the result stays within the hard limit. If it would not, the transaction rolls back, the dropped count is increased, and the batch gets 402.
3. Crossing 80% or 100% queues a warning email in the same transaction. The first refused batch of the period queues the "ingestion stopped" warning together with the dropped-count update.

**Agent turn**
1. The user sends a question → the server checks membership, that AI is enabled, credits and concurrency → reserves 1 credit.
2. The model receives the system prompt (rules, citation format, project name, timezone, today's date, agent context) and the conversation. It calls tools; each tool call is validated, scoped to the project and executed by the query engine, and each `run_query`/`run_funnel` result gets the next card number.
3. Tokens and tool results stream to the browser. The full message (text, tool inputs and results, card numbers, proposals) is stored, and token usage is recorded.
4. If the provider fails before any output, the credit is refunded.

**Monitor trigger** (M6)
1. A job evaluates the monitor → the condition is met while the state is `waiting` or `ok` → an incident opens and the state becomes `triggered`.
2. If AI is on and credits remain: movers are computed and an explanation is written (1 credit).
3. If no triggered email went out in the last 60 minutes: the email is queued to the recipients and the incident is marked emailed. The incident is visible on the Monitors tab either way.
4. A later evaluation finds the value back to normal → the incident closes → a "resolved" email is sent if the incident was emailed.

### External services

| Service | Used for | Owner must |
| --- | --- | --- |
| **Resend** | Transactional and notification email. | Before M1 reaches production: create the account, verify the sending domain (DNS records — an owner action), and create an API key for production. |
| **Stripe** | Checkout, subscriptions, Customer Portal, invoices, Stripe Tax, receipts and failed-payment emails. | Before M2:<br>• create the account;<br>• create Products/Prices for Pro and Business in test and live mode;<br>• configure the Customer Portal: allow card updates, invoices, switching between the two prices, and cancelling at period end;<br>• enable Stripe Tax and tax ID collection;<br>• create webhook endpoints for production and preview with the four events in F6;<br>• enable Stripe customer emails;<br>• decide on VAT handling (Q4). |
| **Anthropic** | Ask Pebble, briefing narratives, alert explanations (via the AI SDK). | Before M4: create an API account, a key, and a monthly spend limit. |

## 6. Architecture and stack

**Shape**: one Next.js 16 App Router application (existing) with `output: "standalone"`, deployed by Nohr as the `next` runtime under PM2 with the 512 MB cap. Production is branch `main` (`pebble.apps.nohr.xyz`); preview is `candidate`. No new processes or services run on the server (D10, D17).

| Concern | Choice |
| --- | --- |
| UI | React 19, Tailwind 4, shadcn/ui on Base UI, lucide icons, next-themes (existing). Charts stay hand-built SVG components (no chart library), extended with bar, number and funnel variants. |
| Data | PostgreSQL 17 (databases `pebble` and `pebble_preview` exist) via Drizzle ORM and `pg`: pool max 10, 5 s connect timeout, 15 s statement timeout (existing). Migrations are generated with drizzle-kit and applied during `pnpm build` (existing), so they must be compatible with the release that is still running (F3). No extensions required. |
| Auth & tenancy | Better Auth with the Drizzle adapter on the same database. Plugins: organization (roles owner/admin/member, invitations), two-factor (TOTP + backup codes), Stripe (organization as customer, reference authorization restricted to the owner). Mounted at `/api/auth/*`. Base URL and trusted origin = `APP_URL`. Rate limiting is stored in the database and keyed by the real client IP (D20). |
| Payments | Stripe via the Better Auth Stripe plugin and the Stripe Node SDK. Subscription state is re-read from the Stripe API on each webhook (D24). |
| Agent | Vercel AI SDK (`ai`, `@ai-sdk/react`, `@ai-sdk/anthropic`) calling the Anthropic API directly (no gateway). `streamText` with typed tools and a step limit; a UI message stream to the browser; messages persisted in PostgreSQL. The model comes from `AGENT_MODEL`. |
| MCP | The official MCP TypeScript SDK: stateless Streamable HTTP in a route handler, behind a bearer-key check. |
| Email | The Resend HTTP API, via the outbox with idempotency keys (F19). |
| Background work | An in-process job runner started from Next.js instrumentation (`register`) in the Node runtime. Jobs and schedules live in PostgreSQL, with leases (`FOR UPDATE SKIP LOCKED`). Replaces the need for an external cron (D10). |
| File storage | None. Exports stream from the database; the SDK archive is a build artefact in `public/`. |
| Caching / queues / search | PostgreSQL only. No Redis. |

**Memory**: the process is capped at 512 MB.
- Agent turns are I/O-bound (streaming). Concurrency is capped at 10 turns per process and 3 per organization.
- Tool results are capped at 100 rows.
- Raw exports stream with a database cursor.
- The job runner processes one job of each kind at a time.

Steady-state RSS should stay under 350 MB; this is a target, checked by the load tests in §7.

**Capacity**: the server is one 2-vCPU VPS.
- **Disk.** `/` has about 20 GB free. That space is shared with:
  - the other projects;
  - build artefacts;
  - PostgreSQL WAL (up to about 1 GB);
  - the nightly `pg_dump` of every database, of which 7 days are kept on the same disk.
- **Cost per event.** Each stored event takes about 0.5 KB in the database (row plus indexes), plus roughly 0.2 KB in each of the 7 dump copies — about 2 KB in total.
- **Limit.** Keeping at least 5 GB free, the server holds about **7 million stored events**, a `pebble` database of roughly 3.5 GB. That is far less than one Business organization at full quota and maximum retention (about 48 million events), so storage has to grow with paid usage (Q10).
- **Monitoring.** The operator console (F22, M8) shows database size and free disk; until then the owner reads them from the Nohr server status.
- Pre-aggregated rollup tables are deferred (§10).

**Environment variables** (names only; values are set in the Nohr dashboard):

| Name | Target | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | production, preview (exist) | PostgreSQL. |
| `APP_URL` | production, preview (exist) | Public origin; auth base URL; same-origin checks; links in emails. |
| `BETTER_AUTH_SECRET` | production, preview (new, generated) | Signing for sessions and tokens; the rate-limit key salt; signing for unsubscribe tokens. |
| `TRUST_PROXY` | all (new, `true`) | Use the last `X-Forwarded-For` entry as the client IP. |
| `OPERATOR_EMAILS` | all (new, owner provides) | Operator accounts; owner of the legacy organization (F3); allowed through the launch gate (F1). |
| `SIGNUP_OPEN` | preview `true` (new); production set by the owner at launch (Q13) | Opens public sign-up (F1, D21). |
| `SUPPORT_EMAIL` | all (new, owner provides) | Contact address on public pages and in emails. |
| `RESEND_API_KEY` | production (new, owner provides; required before M1 reaches production); preview optional | Email sending. |
| `EMAIL_FROM` | all (new) | Sender, e.g. `Pebble <hello@…>` on the verified domain. |
| `EMAIL_TRANSPORT` | preview only (new, `log`) | Writes emails to the runtime log instead of sending them (F19). Never set in production. |
| `STRIPE_SECRET_KEY` | production (live), preview (test) — owner provides | Stripe API. |
| `STRIPE_WEBHOOK_SECRET` | production, preview — owner provides | Webhook signature verification. |
| `STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS` | production, preview — owner provides | Price IDs. |
| `ANTHROPIC_API_KEY` | all — owner provides | AI provider. |
| `AGENT_MODEL` | all | Anthropic model ID (a current Claude Sonnet-class model). |
| `ADMIN_PASSWORD_HASH` | all (exists) | Read only by the pre-M1 release (needed for the rollback window). The owner deletes it after the F3 contract deploy. |

`TEST_DATABASE_URL` is not an app env var. Implementers use it to run `pnpm test:integration` against a `pebble_test*` database.

**Owner actions** (outside the codebase):
- **Before M1 database tasks start**: create a `pebble_test` database with its own role (local-only, like the others) and make its URL available to implementers as `TEST_DATABASE_URL`. Cost: no RAM at rest, under 100 MB of disk.
- **Before M1 merges to production**:
  - create the Resend account, verify the sending domain (DNS) and provide `RESEND_API_KEY` and `EMAIL_FROM`;
  - provide `OPERATOR_EMAILS` and `SUPPORT_EMAIL`;
  - restore the latest nightly `pebble` dump into a `pebble_test_cutover` database for the cutover rehearsal (F3), and drop it afterwards. Disk cost: the size of `pebble`, currently under 10 MB.
- **After M1 is live**: sign up with an `OPERATOR_EMAILS` address to claim the legacy organization, then confirm that M1 works, which allows the contract step.
- **After the F3 contract deploy**: delete `ADMIN_PASSWORD_HASH`.
- **Before M2**: set up Stripe (§5) and decide on VAT handling (Q4).
- **At launch**:
  - supply the Terms and Privacy texts (Q7);
  - set `SIGNUP_OPEN=true` in production (Q13);
  - choose a product domain and point it at the server (DNS plus a Nohr custom domain; no extra RAM or disk).
- **Before M4**: create the Anthropic account and key.
- **Ongoing**: when the `pebble` database passes 3 GB, or free disk on `/` drops below 8 GB, enlarge the disk or move PostgreSQL data or the nightly dumps to a larger volume (Q10).

## 7. Quality

**Security**
- **Tenant isolation is the top requirement.** Every query and mutation is scoped by organization membership. Project-level resources are looked up by (id, projectId), and the project by (id, organizationId). Integration tests cover cross-organization access for every resource type and API, expecting 404.
- **Billing authorization.** Subscription and portal actions are authorized server-side for the owner only (F6), never just by hiding buttons.
- **Agent and MCP limits.** Their tools are read-only and bound to one project. The agent cannot send email, fetch URLs, or create anything without a user's click. A prompt injection can therefore at worst produce wrong text.
- **Secrets.**
  - API keys (ingest and read) and session tokens are stored as SHA-256 hashes and shown once.
  - Passwords are hashed by Better Auth (scrypt). TOTP secrets are encrypted.
  - Stripe webhooks are signature-verified. Unsubscribe links are signed.
  - Verification and reset tokens never appear in logs outside the preview log transport (F19).
- **Requests and cookies.** Mutations check `Origin` against `APP_URL` (existing). Cookies are httpOnly, Secure and SameSite=Lax.
- **Headers.** The existing headers are kept (`X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options: DENY`). `/tracker.v1.js` and `/api/v1/collect` keep their CORS behaviour. The Query API and MCP send no CORS headers (server-to-server).
- **Rate limits** as specified in F1, F5, F11 (20 Ask turns per minute per user), F15 and F17.

**Privacy**
- Tracking stays cookie-less. No raw IPs, full user agents, query strings or form contents are stored (existing). Pebble's own app uses a session cookie for signed-in users only. Custom properties must not contain personal data (documented).
- Only aggregated query results, project metadata and agent context are sent to Anthropic; raw event rows never are. Organizations can switch AI features off (F11).
- Anthropic, Stripe and Resend are listed as subprocessors in the privacy policy.
- Deleting an organization or a project removes its data immediately; backups expire within 7 days.
- Account emails are used only for account, security and billing-related emails, and for notification emails the user opted into.

**Performance targets** (production server, measured server-side)
- Ingestion, including the usage-counter update: p95 < 200 ms at 50 requests/s sustained for 10 minutes. Checked in M2.
- Overview page with a 30-day range on a project with ≤ 1 M events in range: complete in < 2.5 s. Checked in M3.
- Query API / MCP: p95 < 2 s for ≤ 1 M events in range; hard stop at the 15 s statement timeout (`query_timeout`). Checked in M4.
- Ask Pebble: the first streamed step visible < 5 s after sending, excluding provider outages. Checked in M4.
- Process RSS < 400 MB during 10 concurrent agent turns (M4), and with a 31-day raw export running alongside them (M8).

These are targets, not launch gates, until they have been measured. Each milestone listed above runs a load test on preview outside peak hours (preview shares the server with production) and records the results in its task. Seeded data is deleted afterwards. The gate for accepting the milestone is: no PM2 memory restart and no 5xx responses during the test. Missed latency or RSS targets are filed as bugs.

**Accessibility**
- WCAG 2.2 AA on public and app pages: every control reachable by keyboard, visible focus, labelled form fields with inline error messages, sufficient contrast in light and dark themes.
- Every chart has an accessible table alternative ("Show as table").
- The agent's streaming answer is in a polite live region. Citation markers are links with accessible names ("Query card 2"). The Stop button works by keyboard.

**SEO**
- Public pages are indexable, with metadata and a sitemap. Everything else is `noindex`. `robots.txt` as in F21.

**Observability**
- `/api/health` and `/api/ready` (existing).
- Structured one-line logs — with no secrets, no tokens, no analytics payloads and no conversation content — for: job runs, webhook processing, email sends and failures, agent turns (org, project, steps, tokens, duration, outcome), query timeouts and 5xx errors.
- The operator console's System view (F22).

**Testing**
- Keep `pnpm check`, `pnpm build` and `pnpm test:integration` green. Integration tests run against the dedicated `pebble_test*` database the owner provides (§6), and database tasks start only once it exists.
- Integration tests to add:
  - the F3 cutover and old-release compatibility;
  - tenancy isolation;
  - transactional quota enforcement under concurrent batches;
  - webhook idempotency and out-of-order handling;
  - the F8 fixture contract;
  - job and email idempotency.
- Agent tool wiring is tested with a mocked model. Answer quality is tested with the F11 evaluation set against the real model on preview.

## 8. Decisions

**D1 — A hosted multi-tenant SaaS replaces the self-hosted single-admin app.** Users, organizations and payments, which the brief asks for, need tenancy. Alternative: keep a self-hosted edition alongside — that doubles the configuration paths and the testing. The single-admin mode is retired (Q9).

**D2 — Better Auth for accounts, organizations, 2FA and Stripe subscriptions.** It runs inside the Next.js process on PostgreSQL through the existing Drizzle setup. It ships organization roles and invitations, TOTP 2FA, and an organization-level Stripe plugin with a reference-authorization hook. Alternatives: hand-rolling (more security-critical code to write and maintain); Auth.js (no organizations or billing); Clerk or WorkOS (paid external services, with user data off the server).

**D3 — Stripe (Checkout + Customer Portal + Stripe Tax) as the payment processor.** It is standard for B2B subscriptions, hosted payment pages keep card data off Pebble, and the portal removes the need to build invoice and card UI. Alternative: Paddle or Lemon Squeezy as merchant of record — they handle VAT remittance, but take a larger fee and fit Better Auth less directly. See Q4.

**D4 — Plans differ only in numeric limits.** Every feature on every plan keeps permission logic simple and lets Free users try the agent. Alternative: gating features (e.g. MCP only on paid plans) — more rules to build and test.

**D5 — The usage period is the calendar month in UTC for every organization.** Simple to compute, display and test. Alternative: the Stripe billing period — it differs per organization and does not exist for Free.

**D6 — Event quota: Free stops at 100 %, paid plans at 120 %.** Paying customers should not lose data because of a spike, while Free must stay bounded on a small server. Alternatives: metered overage billing (complex, §10), or a hard stop at 100 % for everyone.

**D7 — Anthropic Claude through the Vercel AI SDK.** Strong tool use. The AI SDK provides streaming UI, typed tools and a step limit, and allows switching provider later without rewriting the agent. Alternatives: OpenAI; the Anthropic SDK directly (no UI streaming helpers); an AI gateway (an extra dependency).

**D8 — The agent queries through typed tools, never through generated SQL.** This guarantees project scoping, bounded cost and identical numbers across surfaces, and makes every answer inspectable through cited query cards. Alternative: text-to-SQL on a read-only role — risks cross-tenant reads, slow queries and answers that cannot be verified.

**D9 — One query engine and one metric contract for the dashboard, agent, API, MCP, pins, monitors and briefings.** One set of metric definitions, pinned by fixtures, and one place to optimise. Alternative: keep bespoke report SQL beside an agent API — the numbers would drift.

**D10 — Background jobs run inside the app process, with a PostgreSQL job table.** Nohr allows no separate worker or cron process, and leases plus idempotent jobs survive restarts and deploys. Alternatives: system cron calling an endpoint (an owner server change), or a Redis queue (an extra service).

**D11 — Resend for email.** A simple HTTP API with idempotency keys, a generous free tier, and good deliverability with domain verification. Alternatives: Postmark (similar, no free tier); Amazon SES (more setup); the server's own SMTP (not installed, poor deliverability).

**D12 — MCP over stateless Streamable HTTP with read-key bearer auth.** It works with Claude Code, Cursor and generic clients today, and needs no session storage. Alternative: a full OAuth 2.1 authorization server (needed for some hosted connector directories) — deferred (§10).

**D13 — Existing data migrates into a "Pebble" organization, claimed by the first `OPERATOR_EMAILS` user.** All project IDs, snippets and keys keep working. Alternatives: wipe and start fresh (loses history), or a manual claim tool.

**D14 — One "AI credit" counter for chat turns, briefing narratives and alert explanations.** Easy to explain and to price. Alternatives: token-based billing (hard for customers to predict), or separate counters.

**D15 — Conversations are private to their creator.** This avoids exposing exploratory questions. Results are shared through Overview URLs and, later, pins. Alternative: conversations visible to the whole organization.

**D16 — Funnels count visitors who complete the steps in order within the selected range.** Simple and predictable, and it lets server events with visitor context count in later visits. Alternatives: per-visit funnels, or configurable conversion windows.

**D17 — The public site, docs and app live in the same Next.js application.** One deploy and a shared design system. Alternative: a separate static marketing site (a second deploy, duplicated styles).

**D18 — Downgrades never delete data immediately; retention caps apply after a 30-day grace period.** This protects customers from accidental loss after a failed payment. Alternative: immediate enforcement.

**D19 — Preview uses Stripe test mode, and writes emails to the runtime log only when `EMAIL_TRANSPORT=log`.** The tester can run sign-up, verification and checkout on preview without sending real mail or money. Log mode is never automatic: a missing Resend key alone never puts links or tokens in a log. Alternatives: logging whenever the key is unset — in production that would leak sign-in links to the log; or a second Resend domain for preview.

**D20 — The client IP is the last `X-Forwarded-For` entry when `TRUST_PROXY=true`.** Nohr's Caddy appends the real client address. The current code reads `X-Real-IP`, which Caddy does not set, so today all clients share one rate-limit bucket — unacceptable once many customers sign in. Alternative: keep the shared bucket, which lets one attacker lock everyone out of sign-in.

**D21 — A launch gate (`SIGNUP_OPEN`) controls public sign-up.** It keeps production closed while F3's rollback window is open, plan limits are missing (M1), or legal texts are absent. Operators and invitees can still get in, and preview stays open for testing. Alternatives: open sign-up on the first deploy; or close it automatically while the legal files are missing — that would also block sign-up testing on preview.

**D22 — Event usage is recorded at ingestion, in the batch's own transaction, and the counter is the usage record.** Usage then never overshoots the hard limit under concurrency, and retention or deletions cannot lower a month's recorded usage. The counter update is the transaction's last statement, so each organization's counter row is locked only until commit. Alternative: recount from stored events every few minutes — this allows concurrent overshoot, lags enforcement, and loses usage when data is deleted.

**D23 — Expand-and-contract cutover from the single-admin app.** Migrations run during `pnpm build`, while the old release is still serving. Additive-only changes in M1 keep the old release working during the build and make rollback possible. Old structures are removed only in M2, once the new release is confirmed in production. Alternative: one migration that drops `admin_sessions` and enforces `organizationId` immediately — this breaks the running release during the build, and leaves no rollback.

**D24 — Billing actions are authorized for the owner on the server, and subscription state is re-read from Stripe on every webhook.** This stops admins or other organizations from calling the plugin's endpoints directly, and stops delayed or out-of-order webhooks from reverting a newer plan. Alternatives: rely on hidden buttons (unsafe); compare event timestamps (event times can tie, and the comparison needs extra stored state).

**D25 — The core agent loop ships before goals, funnels, monitors, briefings and pins.** The query engine, Ask Pebble, the Query API and MCP are the core of an agent-first product. Goals and funnels, monitors, briefings, pins, raw export, the audit-log page and the operator console then follow one at a time. Alternative: version 1's order, which put goals, funnels and pins before the agent and delayed the core product.

## 9. Open questions

**Q1 — Prices and currency.** Assumed: EUR, monthly only; Free €0 / Pro €39 / Business €149, excl. VAT. Prices live in Stripe, so changing them needs only new Price IDs.

**Q2 — Plan limits.** Assumed: the table in F6. The AI credit allowances assume a provider cost of roughly €0.05–0.10 per credit; the owner should check this against the chosen model's pricing. Note: Business at full quota and maximum retention exceeds the server's current storage (Q10).

**Q3 — Free trial of paid plans.** Assumed: none; the Free plan is the trial. A 14-day card-less Pro trial can be added through Stripe later.

**Q4 — VAT and merchant of record.** Will the owner take responsibility for VAT registration and remittance (e.g. EU OSS), or use a merchant of record? Assumed: Stripe with Stripe Tax, with the owner taking on VAT obligations; the owner sets the live Stripe keys in production only after confirming this. If the owner prefers not to handle VAT, switch to a merchant of record (Paddle) before M2.

**Q5 — Product domain and email sending domain.** Assumed: the app stays at `pebble.apps.nohr.xyz` until the owner picks a domain, and email is sent from a domain the owner verifies in Resend. `APP_URL` must change with the domain. Tracker snippets embed it, so existing installs keep working only if the old host keeps serving.

**Q6 — AI provider and model.** Assumed: Anthropic, with a current Claude Sonnet-class model set in `AGENT_MODEL`.

**Q7 — Legal entity and legal texts.** Assumed: the owner supplies the Terms, Privacy Policy and DPA texts, naming Anthropic, Stripe, Resend and Hetzner as subprocessors. Until they are supplied, the pages say "being prepared" and Upgrade stays disabled in production (live Stripe keys); it works on preview.

**Q8 — Existing production data.** Assumed: it is real, and it is migrated into the "Pebble" organization (F3) rather than wiped.

**Q9 — Self-hosted edition.** Assumed: discontinued. The README's self-hosting instructions are replaced by developer instructions for this deployment.

**Q10 — Server capacity.** Assumed: the current VPS until the `pebble` database reaches about 3 GB (roughly 6–7 million stored events), or free disk on `/` drops below 8 GB. At that point the owner enlarges the disk, or moves PostgreSQL data or the nightly dumps to a larger volume. The existing 10 GB volume (9 GB free) could take the dumps. These are owner actions with no RAM cost. Selling Business plans at scale needs this first.

**Q11 — Node SDK distribution.** Assumed: the SDK archive is served from the app at `/sdk/…` and not published to npm. Publishing `@pebble/analytics` would need an npm organization owned by the owner.

**Q12 — Conversation visibility.** Assumed: private to the creator (D15).

**Q13 — May public sign-up open before real Terms and Privacy texts are supplied?** Assumed: no. Production keeps `SIGNUP_OPEN` unset — only operators and invitees can sign up — until the texts are committed and M2 (plans and billing) is live. Preview is open for testing.

## 10. Out of scope

Deliberately left out of the first version (candidates for later):

- **Access**: SSO/SAML, SCIM, Google/GitHub sign-in, magic links, passkeys, enforcing 2FA organization-wide, email-address change, project-level permissions, a read-only "viewer" role, impersonation by operators.
- **Billing**: annual plans, per-seat pricing, metered overage billing, free trials, coupons managed inside Pebble (Stripe promotion codes work at checkout), invoices rendered by Pebble.
- **Agent**: conversations across several projects, shared conversations, the agent performing changes without a click, scheduled custom agent tasks, answer feedback (thumbs), file/CSV uploads to the agent, voice, choosing models per organization, causal-inference claims beyond correlations.
- **Agent access**: OAuth 2.1 for MCP (for hosted connector directories), write tools over MCP, webhooks out of Pebble, Slack/Teams notifications and alert channels other than email.
- **Analytics**: country/region (needs a GeoIP database), cohorts and retention curves, revenue tracking and attribution models, user identification and profiles, session replay, heatmaps, A/B testing, scroll/outbound-link/file-download auto-tracking, Core Web Vitals, public/shared dashboards, custom dashboards beyond the Pinned board, annotations, an event catalogue with per-event descriptions, deleting a single visitor's data, pre-aggregated rollup tables.
- **Data**: scheduled exports, warehouse sync (BigQuery/Snowflake/S3), data import from other tools.
- **Platform**: self-hosted edition, first-party proxy / custom tracking domains, mobile and non-Node server SDKs, npm publishing of the SDK, localisation (English only), multi-region hosting, a status page.

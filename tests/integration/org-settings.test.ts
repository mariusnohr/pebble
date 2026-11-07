import "next/dist/server/node-environment-baseline.js";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq, inArray } from "drizzle-orm";
import { getDb, closeDb } from "../../src/db";
import {
  apiKeys,
  events,
  visits,
  invitation,
  usagePeriods,
  auditLog,
  emailOutbox,
  member,
  organization,
  projects,
  user,
} from "../../src/db/schema";
import { requireTestDatabaseUrl } from "../../scripts/rehearse-cutover";
import { LEGACY_ORGANIZATION_ID } from "../../src/server/legacy-organization";
import {
  workAsyncStorage,
  type WorkStore,
} from "next/dist/server/app-render/work-async-storage.external.js";
import {
  workUnitAsyncStorage,
  type RequestStore,
} from "next/dist/server/app-render/work-unit-async-storage.external.js";

process.env.DATABASE_URL = requireTestDatabaseUrl(process.env.TEST_DATABASE_URL);
process.env.APP_URL = "http://localhost:3000";
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.TRUST_PROXY = "true";
process.env.SIGNUP_OPEN = "true";
const { handleAuth } = await import("../../src/server/auth-handler");
const { resolveOrganization, requireOrganizationSettings } =
  await import("../../src/server/tenancy");
const { createOrganization, deleteOrganization, updateOrganization } =
  await import("../../src/server/organizations");
const actions = await import("../../src/server/actions");
const { default: AppPage } = await import("../../src/app/app/page");
const { POST: collect } = await import("../../src/app/api/v1/collect/route");
const db = getDb();
const emails: string[] = [],
  orgIds: string[] = [],
  userIds: string[] = [],
  projectIds: string[] = [];
const password = "a-test-password-for-pebble";
const notFound = (error: unknown) =>
  error instanceof Error && "digest" in error && error.digest === "NEXT_HTTP_ERROR_FALLBACK;404";
const form = (values: Record<string, string>) => {
  const result = new FormData();
  for (const [key, value] of Object.entries(values)) result.set(key, value);
  return result;
};
function request(path: string, body?: Record<string, unknown>, ip = randomUUID(), cookie = "") {
  return handleAuth(
    new Request(`${process.env.APP_URL}/api/auth/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        origin: process.env.APP_URL!,
        "Content-Type": "application/json",
        "x-forwarded-for": `spoofed, ${ip}`,
        cookie,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}
function asUser<T>(cookie: string, run: () => T): T {
  // Supply Next's real request context, so tests exercise exported actions and guards.
  return workAsyncStorage.run(
    { route: "/app/test", page: "/app/test/page", incrementalCache: {} } as WorkStore,
    () =>
      workUnitAsyncStorage.run(
        {
          type: "request",
          phase: "action",
          headers: new Headers({ cookie, origin: process.env.APP_URL! }),
        } as RequestStore,
        run,
      ),
  );
}
async function signup(email = `account-${randomUUID()}@example.com`) {
  emails.push(email.toLowerCase());
  const response = await request("sign-up/email", {
    name: "Test account",
    email,
    password,
    termsAccepted: true,
  });
  assert.equal(response.status, 200);
  const [actor] = await db.select().from(user).where(eq(user.email, email.toLowerCase()));
  if (actor && !userIds.includes(actor.id)) userIds.push(actor.id);
  return actor;
}
async function tokenFor(email: string) {
  const rows = await db.select().from(emailOutbox).where(eq(emailOutbox.to, email));
  const mail = rows.find((row) => row.template === "verifyEmail");
  assert.ok(mail);
  const payload = mail.payload as { links: { path: string }[] };
  return new URL(payload.links[0].path, process.env.APP_URL).searchParams.get("token")!;
}
async function verified(email?: string) {
  const actor = await signup(email);
  const response = await request(`verify-email?token=${await tokenFor(actor.email)}`);
  assert.equal(response.status, 200);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert.match(cookie, /session_token=/);
  return { actor: { ...actor, emailVerified: true }, cookie };
}
async function orgFor(userId: string, name = "Test team") {
  const org = await createOrganization(userId, name);
  orgIds.push(org.id);
  return org;
}
async function projectFor(orgId: string | null) {
  const [project] = await db
    .insert(projects)
    .values({ name: "Test project", organizationId: orgId, origins: ["https://example.com"] })
    .returning();
  projectIds.push(project.id);
  return project;
}
before(async () => {
  await migrate(db, { migrationsFolder: "drizzle" });
});
after(async () => {
  if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds));
  if (orgIds.length) await db.delete(organization).where(inArray(organization.id, orgIds));
  if (userIds.length) {
    await db.delete(member).where(inArray(member.userId, userIds));
    await db.delete(user).where(inArray(user.id, userIds));
  }
  if (emails.length) await db.delete(emailOutbox).where(inArray(emailOutbox.to, emails));
  await closeDb();
});

const redirectedTo = (path: string) => (error: unknown) =>
  error instanceof Error &&
  "digest" in error &&
  String(error.digest) === `NEXT_REDIRECT;replace;${path};307;`;

async function audits(id: string) {
  return db.select().from(auditLog).where(eq(auditLog.organizationId, id));
}

test("owner renames and changes slug with actor-labelled audits and old URL becomes 404", async () => {
  const { actor, cookie } = await verified();
  const org = await orgFor(actor.id);
  const name = "Renamed organization";
  assert.deepEqual(
    await asUser(cookie, () =>
      actions.updateOrganizationAction({}, form({ org: org.slug, name, slug: org.slug })),
    ),
    { success: "Organization updated." },
  );
  const slug = `changed-${randomUUID().slice(0, 8)}`;
  await assert.rejects(
    asUser(cookie, () => actions.updateOrganizationAction({}, form({ org: org.slug, name, slug }))),
    redirectedTo(`/app/${slug}/settings`),
  );
  assert.equal(
    (await asUser(cookie, () => requireOrganizationSettings(slug))).organization.name,
    name,
  );
  await assert.rejects(
    asUser(cookie, () => requireOrganizationSettings(org.slug)),
    notFound,
  );
  await assert.rejects(resolveOrganization(org.slug, actor), notFound);
  // A no-op save must not duplicate either audit entry.
  await asUser(cookie, () => actions.updateOrganizationAction({}, form({ org: slug, name, slug })));
  const entries = await audits(org.id);
  assert.equal(entries.length, 2);
  for (const [action, from, to] of [
    ["organization.renamed", org.name, name],
    ["organization.slug_changed", org.slug, slug],
  ]) {
    const entry = entries.find((row) => row.action === action)!;
    assert.ok(entry);
    assert.equal(entry.actorUserId, actor.id);
    assert.equal(entry.actorLabel, `${actor.name} <${actor.email}>`);
    assert.equal(entry.targetType, "organization");
    assert.equal(entry.targetId, org.id);
    assert.deepEqual(entry.details, { from, to });
  }
});

test("invalid names and invalid, reserved or taken slugs leave settings and audit unchanged", async () => {
  const { actor, cookie } = await verified();
  const org = await orgFor(actor.id),
    taken = await orgFor(actor.id, "Taken team");
  for (const [slug, message] of [
    ...["app", "account", "new", "invitations", "operator", "api"].map(
      (value) => [value, /reserved/] as const,
    ),
    [taken.slug, /already taken/] as const,
    ...[
      "ab",
      "x".repeat(41),
      "Uppercase",
      "has space",
      "under_score",
      "équipe",
      "bad/slug",
      " padded ",
    ].map((value) => [value, /3–40/] as const),
  ]) {
    const result = await asUser(cookie, () =>
      actions.updateOrganizationAction({}, form({ org: org.slug, name: "Must not change", slug })),
    );
    assert.match(result.error!, message);
  }
  for (const name of ["", "   ", "x".repeat(61)]) {
    const result = await asUser(cookie, () =>
      actions.updateOrganizationAction({}, form({ org: org.slug, name, slug: org.slug })),
    );
    assert.match(result.error!, /1–60/);
  }
  assert.deepEqual((await resolveOrganization(org.slug, actor)).organization, org);
  assert.equal((await audits(org.id)).length, 0);
});

test("admin can edit General but cannot delete even with the correct name", async () => {
  const owner = await verified(),
    admin = await verified();
  const org = await orgFor(owner.actor.id);
  const project = await projectFor(org.id);
  await db.insert(member).values({
    organizationId: org.id,
    userId: admin.actor.id,
    role: "admin",
    createdAt: new Date(),
  });
  assert.equal(
    (await asUser(admin.cookie, () => requireOrganizationSettings(org.slug))).role,
    "admin",
  );
  const name = "Admin rename",
    slug = `admin-${randomUUID().slice(0, 8)}`;
  await assert.rejects(
    asUser(admin.cookie, () =>
      actions.updateOrganizationAction({}, form({ org: org.slug, name, slug })),
    ),
    redirectedTo(`/app/${slug}/settings`),
  );
  const result = await asUser(admin.cookie, () =>
    actions.deleteOrganizationAction({}, form({ org: slug, confirmation: name })),
  );
  assert.match(result.error!, /Only the owner/);
  assert.equal((await resolveOrganization(slug, owner.actor)).organization.id, org.id);
  assert.equal((await db.select().from(projects).where(eq(projects.id, project.id))).length, 1);
  assert.ok((await audits(org.id)).every((entry) => entry.actorUserId === admin.actor.id));
});

test("General's server guard returns 404 to members and outsiders; direct actions cannot bypass roles", async () => {
  const owner = await verified(),
    reader = await verified(),
    outsider = await verified();
  const org = await orgFor(owner.actor.id);
  await db.insert(member).values({
    organizationId: org.id,
    userId: reader.actor.id,
    role: "member",
    createdAt: new Date(),
  });
  for (const actor of [reader, outsider])
    await assert.rejects(
      asUser(actor.cookie, () => requireOrganizationSettings(org.slug)),
      notFound,
    );
  const values = form({
    org: org.slug,
    name: "Forbidden",
    slug: "forbidden",
    confirmation: org.name,
  });
  assert.match(
    (await asUser(reader.cookie, () => actions.updateOrganizationAction({}, values))).error!,
    /Only owners and admins/,
  );
  assert.match(
    (await asUser(reader.cookie, () => actions.deleteOrganizationAction({}, values))).error!,
    /Only the owner/,
  );
  await assert.rejects(
    asUser(outsider.cookie, () => actions.updateOrganizationAction({}, values)),
    notFound,
  );
  await assert.rejects(
    asUser(outsider.cookie, () => actions.deleteOrganizationAction({}, values)),
    notFound,
  );
  assert.deepEqual((await resolveOrganization(org.slug, owner.actor)).organization, org);
  assert.equal((await audits(org.id)).length, 0);
});

test("exact-name deletion cascades, old collect returns 404, and /app selects another organization or /app/new", async () => {
  const { actor, cookie } = await verified();
  const fallback = await orgFor(actor.id, "Fallback");
  const org = await orgFor(actor.id, "Delete Me");
  const project = await projectFor(org.id);
  const collectRequest = () =>
    new Request(`${process.env.APP_URL}/api/v1/collect`, {
      method: "POST",
      headers: {
        origin: "https://example.com",
        "content-type": "application/json",
        "x-forwarded-for": randomUUID(),
      },
      body: JSON.stringify({
        projectId: project.id,
        events: [
          {
            id: randomUUID(),
            type: "pageview",
            path: "/",
            visitorId: randomUUID(),
            visitId: randomUUID(),
          },
        ],
      }),
    });
  assert.equal((await collect(collectRequest())).status, 200);
  await db
    .insert(apiKeys)
    .values({ projectId: project.id, name: "Key", prefix: "pb_test", tokenHash: randomUUID() });
  await db.insert(invitation).values({
    organizationId: org.id,
    inviterId: actor.id,
    email: "invited@example.com",
    role: "member",
    expiresAt: new Date(Date.now() + 86400000),
  });
  await db.insert(usagePeriods).values({ organizationId: org.id, period: "2026-11", events: 1 });
  await asUser(cookie, () =>
    actions.updateOrganizationAction(
      {},
      form({ org: org.slug, name: "Delete Me Now", slug: org.slug }),
    ),
  );
  for (const confirmation of ["Delete Me", "delete me now", "Delete Me Now ", ""]) {
    const result = await asUser(cookie, () =>
      actions.deleteOrganizationAction({}, form({ org: org.slug, confirmation })),
    );
    assert.match(result.error!, /exactly/);
    assert.equal((await db.select().from(projects).where(eq(projects.id, project.id))).length, 1);
  }
  assert.equal((await db.select().from(visits).where(eq(visits.projectId, project.id))).length, 1);
  assert.equal((await db.select().from(events).where(eq(events.projectId, project.id))).length, 1);
  await assert.rejects(
    asUser(cookie, () =>
      actions.deleteOrganizationAction({}, form({ org: org.slug, confirmation: "Delete Me Now" })),
    ),
    redirectedTo("/app"),
  );
  assert.equal((await db.select().from(projects).where(eq(projects.id, project.id))).length, 0);
  for (const table of [visits, events, apiKeys])
    assert.equal((await db.select().from(table).where(eq(table.projectId, project.id))).length, 0);
  for (const table of [member, invitation, usagePeriods, auditLog])
    assert.equal((await db.select().from(table).where(eq(table.organizationId, org.id))).length, 0);
  assert.equal((await db.select().from(organization).where(eq(organization.id, org.id))).length, 0);
  assert.equal(
    (await db.select().from(user).where(eq(user.id, actor.id)))[0].lastOrganizationId,
    null,
  );
  assert.equal((await collect(collectRequest())).status, 404);
  await assert.rejects(
    asUser(cookie, () => AppPage()),
    redirectedTo(`/app/${fallback.slug}`),
  );
  assert.equal(
    (await db.select().from(user).where(eq(user.id, actor.id)))[0].lastOrganizationId,
    fallback.id,
  );
  await assert.rejects(
    asUser(cookie, () =>
      actions.deleteOrganizationAction(
        {},
        form({ org: fallback.slug, confirmation: fallback.name }),
      ),
    ),
    redirectedTo("/app"),
  );
  await assert.rejects(
    asUser(cookie, () => AppPage()),
    redirectedTo("/app/new"),
  );
});

test("competing slug changes have one winner and one clear error", async () => {
  const a = await verified(),
    b = await verified();
  const first = await orgFor(a.actor.id),
    second = await orgFor(b.actor.id);
  const slug = `race-${randomUUID().slice(0, 8)}`;
  const results = await Promise.allSettled([
    asUser(a.cookie, () =>
      actions.updateOrganizationAction({}, form({ org: first.slug, name: first.name, slug })),
    ),
    asUser(b.cookie, () =>
      actions.updateOrganizationAction({}, form({ org: second.slug, name: second.name, slug })),
    ),
  ]);
  const redirected = results.filter((result) => result.status === "rejected");
  assert.equal(redirected.length, 1);
  assert.ok(redirectedTo(`/app/${slug}/settings`)(redirected[0].reason));
  const refused = results.filter((result) => result.status === "fulfilled");
  assert.equal(refused.length, 1);
  assert.match(refused[0].value.error!, /already taken/);
  assert.equal((await audits(first.id)).length + (await audits(second.id)).length, 1);
});

test("/app clears a last-used organization that the user no longer belongs to", async () => {
  const owner = await verified(),
    formerMember = await verified();
  const org = await orgFor(owner.actor.id);
  await db
    .update(user)
    .set({ lastOrganizationId: org.id })
    .where(eq(user.id, formerMember.actor.id));
  await assert.rejects(
    asUser(formerMember.cookie, () => AppPage()),
    redirectedTo("/app/new"),
  );
  assert.equal(
    (await db.select().from(user).where(eq(user.id, formerMember.actor.id)))[0].lastOrganizationId,
    null,
  );
});

test("legacy deletion includes NULL-owned projects, with rollback preserving the fixture", async () => {
  const project = await projectFor(null);
  const rollback = new Error("Rollback legacy deletion test");
  await assert.rejects(
    db.transaction(async (tx) => {
      await deleteOrganization(tx, LEGACY_ORGANIZATION_ID);
      assert.equal((await tx.select().from(projects).where(eq(projects.id, project.id))).length, 0);
      throw rollback;
    }),
    (error) => error === rollback,
  );
});

test("deleting Pebble does not prevent another operator from verifying their email", async () => {
  const [legacy] = await db
    .select()
    .from(organization)
    .where(eq(organization.id, LEGACY_ORGANIZATION_ID));
  assert.ok(legacy);
  const firstEmail = `operator-${randomUUID()}@example.com`;
  const nextEmail = `operator-${randomUUID()}@example.com`;
  const previousOperators = process.env.OPERATOR_EMAILS;
  process.env.OPERATOR_EMAILS = `${firstEmail},${nextEmail}`;
  try {
    const owner = await verified(firstEmail);
    assert.equal((await resolveOrganization(legacy.slug, owner.actor)).role, "owner");
    await assert.rejects(
      asUser(owner.cookie, () =>
        actions.deleteOrganizationAction({}, form({ org: legacy.slug, confirmation: legacy.name })),
      ),
      redirectedTo("/app"),
    );
    const next = await verified(nextEmail);
    const [account] = await db.select().from(user).where(eq(user.id, next.actor.id));
    assert.equal(account.emailVerified, true);
    assert.equal(account.lastOrganizationId, null);
    assert.equal(
      (await db.select().from(member).where(eq(member.userId, next.actor.id))).length,
      0,
    );
    assert.equal(
      (await db.select().from(organization).where(eq(organization.id, legacy.id))).length,
      0,
    );
    const sessionResponse = await request("get-session", undefined, undefined, next.cookie);
    assert.equal(sessionResponse.status, 200);
    assert.equal((await sessionResponse.json()).user.id, next.actor.id);
  } finally {
    if (previousOperators === undefined) delete process.env.OPERATOR_EMAILS;
    else process.env.OPERATOR_EMAILS = previousOperators;
    // The following tenancy suite also uses the migration's legacy organization fixture.
    await db.insert(organization).values(legacy).onConflictDoNothing();
  }
});

async function waitForBlockedQuery(blockerPid: number, query: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await db.$client.query<{ pid: number }>(
      `select pid from pg_stat_activity
       where datname = current_database() and $1 = any(pg_blocking_pids(pid))
       and position($2 in query) > 0`,
      [blockerPid, query],
    );
    if (rows.length) return rows[0].pid;
    await delay(10);
  }
  assert.fail("Expected database lock wait was not observed.");
}

test("same-owner creation and settings updates complete with synchronized lock contention", async () => {
  const { actor } = await verified();
  const org = await orgFor(actor.id);
  const name = "Concurrent rename",
    slug = `concurrent-${randomUUID().slice(0, 8)}`;
  const blocker = await db.$client.connect();
  const pending: Promise<unknown>[] = [];
  try {
    await blocker.query("begin");
    const {
      rows: [{ pid }],
    } = await blocker.query<{ pid: number }>("select pg_backend_pid() as pid");
    await blocker.query("select id from organization where id = $1 for update", [org.id]);
    // Settings holds the advisory lock but cannot update the organization yet.
    const updating = updateOrganization(actor, org.slug, { name, slug });
    pending.push(updating);
    void updating.catch(() => {});
    const updatePid = await waitForBlockedQuery(pid, '"organization"');
    const creating = orgFor(actor.id, "Concurrent creation");
    pending.push(creating);
    void creating.catch(() => {});
    await waitForBlockedQuery(updatePid, "pg_advisory_xact_lock(71001)");
    // Before the fix, creation held the user FOR UPDATE at this point; releasing
    // the organization made the settings audit wait on that user and deadlock.
    await blocker.query("commit");
    const [updated, created] = await Promise.all([updating, creating]);
    assert.equal(updated.name, name);
    assert.equal(updated.slug, slug);
    assert.equal((await resolveOrganization(created.slug, actor)).role, "owner");
    assert.equal((await resolveOrganization(slug, actor)).organization.id, org.id);
    await assert.rejects(resolveOrganization(org.slug, actor), notFound);
    const entries = await audits(org.id);
    assert.deepEqual(entries.map((entry) => entry.action).sort(), [
      "organization.renamed",
      "organization.slug_changed",
    ]);
    assert.ok(entries.every((entry) => entry.actorUserId === actor.id));
  } finally {
    await blocker.query("rollback");
    blocker.release();
    await Promise.allSettled(pending);
  }
});

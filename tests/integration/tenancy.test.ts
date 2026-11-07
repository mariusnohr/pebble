import "next/dist/server/node-environment-baseline.js";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { prepareContractDatabase } from "./fixtures/contract-schema";
import { eq, inArray } from "drizzle-orm";
import { signJWT } from "better-auth/crypto";
import { getDb, closeDb } from "../../src/db";
import {
  apiKeys,
  auditLog,
  emailOutbox,
  member,
  organization,
  projects,
  session,
  user,
  verification,
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
const { handleAuth, ATTEMPT_LIMIT_MESSAGE } = await import("../../src/server/auth-handler");
const { resolveProject, resolveOrganization } = await import("../../src/server/tenancy");
const { createOrganization, deleteOrganization } = await import("../../src/server/organizations");
const { getProject, listProjects, listKeys, getRealtime, getReport, getPortfolio } =
  await import("../../src/server/queries");
const actions = await import("../../src/server/actions");
const { GET: realtime } = await import("../../src/app/api/projects/[id]/realtime/route");
const { GET: firstEvent } = await import("../../src/app/api/projects/[id]/first-event/route");
const { POST: collect } = await import("../../src/app/api/v1/collect/route");
const { GET: legacy } = await import("../../src/app/projects/[id]/[[...path]]/route");
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
async function verified() {
  const actor = await signup();
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
async function projectFor(orgId: string) {
  const [project] = await db
    .insert(projects)
    .values({ name: "Test project", organizationId: orgId, origins: ["https://example.com"] })
    .returning();
  projectIds.push(project.id);
  return project;
}
before(async () => {
  await prepareContractDatabase(db.$client);
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

test("launch gate rejects without storing a user or email but permits operators", async () => {
  delete process.env.SIGNUP_OPEN;
  const email = `closed-${randomUUID()}@example.com`;
  process.env.OPERATOR_EMAILS = ` ${email.toUpperCase()} `;
  const denied = `denied-${randomUUID()}@example.com`;
  const response = await request("sign-up/email", {
    name: "Test",
    email: denied,
    password,
    termsAccepted: true,
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).message, "Pebble isn't open for sign-up yet");
  assert.equal((await db.select().from(user).where(eq(user.email, denied))).length, 0);
  assert.equal((await db.select().from(emailOutbox).where(eq(emailOutbox.to, denied))).length, 0);
  await signup(email);
  process.env.SIGNUP_OPEN = "true";
  delete process.env.OPERATOR_EMAILS;
});

test("verification is required, single use, expiring, and duplicate signup sends only a security notice", async () => {
  const actor = await signup();
  const unverified = await request("sign-in/email", { email: actor.email, password });
  assert.equal((await unverified.json()).code, "EMAIL_NOT_VERIFIED");
  await assert.rejects(resolveOrganization("pebble", actor), notFound);
  const token = await tokenFor(actor.email);
  const expired = await signJWT(
    { email: actor.email, userId: actor.id },
    process.env.BETTER_AUTH_SECRET!,
    -1,
  );
  assert.equal((await request(`verify-email?token=${expired}`)).status, 400);
  const first = await request(`verify-email?token=${token}`);
  assert.equal(first.status, 200);
  assert.match(first.headers.get("set-cookie")!, /HttpOnly/i);
  assert.match(first.headers.get("set-cookie")!, /SameSite=Lax/i);
  const second = await request(`verify-email?token=${token}`);
  assert.equal((await second.json()).code, "ALREADY_USED");
  await signup(actor.email.toUpperCase());
  const mail = await db.select().from(emailOutbox).where(eq(emailOutbox.to, actor.email));
  assert.equal(mail.filter((row) => row.template === "verifyEmail").length, 1);
  assert.equal(mail.filter((row) => row.template === "signupAttempt").length, 1);
  assert.deepEqual(
    (mail.find((row) => row.template === "signupAttempt")!.payload as { links: unknown[] }).links,
    [],
  );
});

test("resending verification is limited to three per address per hour", async () => {
  const actor = await signup();
  for (let i = 0; i < 3; i++)
    assert.equal((await request("send-verification-email", { email: actor.email })).status, 200);
  assert.equal(
    (await request("send-verification-email", { email: actor.email.toUpperCase() })).status,
    429,
  );
});

test("first verified operator claims Pebble atomically and concurrent claims cannot replace its owner", async () => {
  const first = await signup(),
    second = await signup();
  process.env.OPERATOR_EMAILS = `${first.email.toUpperCase()}, ${second.email}`;
  const tokens = await Promise.all([tokenFor(first.email), tokenFor(second.email)]);
  const results = await Promise.all(tokens.map((token) => request(`verify-email?token=${token}`)));
  assert.ok(results.every((response) => response.status === 200));
  const owners = await db
    .select()
    .from(member)
    .where(eq(member.organizationId, LEGACY_ORGANIZATION_ID));
  const winner = owners.find((row) => row.role === "owner")!;
  assert.ok([first.id, second.id].includes(winner.userId));
  assert.equal(owners.filter((row) => row.role === "owner").length, 1);
  const [owner] = await db.select().from(user).where(eq(user.id, winner.userId));
  assert.equal(owner.emailVerified, true);
  assert.equal(owner.lastOrganizationId, LEGACY_ORGANIZATION_ID);
  const legacyProject = await projectFor(LEGACY_ORGANIZATION_ID);
  const winnerIndex = winner.userId === first.id ? 0 : 1;
  const cookie = results[winnerIndex].headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const target = await asUser(cookie, () =>
    legacy(new Request(`${process.env.APP_URL}/projects/${legacyProject.id}/events?days=30`), {
      params: Promise.resolve({ id: legacyProject.id, path: ["events"] }),
    }),
  );
  assert.equal(target.status, 307);
  assert.equal(
    target.headers.get("location"),
    `${process.env.APP_URL}/app/pebble/projects/${legacyProject.id}/events?days=30`,
  );
  await db.delete(member).where(eq(member.id, winner.id));
  delete process.env.OPERATOR_EMAILS;
});

test("tenant reads, key actions and realtime reject foreign IDs; member mutations change nothing", async () => {
  const a = await verified(),
    b = await verified();
  const orgA = await orgFor(a.actor.id),
    orgB = await orgFor(b.actor.id);
  const projectA = await projectFor(orgA.id),
    projectB = await projectFor(orgB.id);
  const [key] = await db
    .insert(apiKeys)
    .values({
      projectId: projectA.id,
      name: "Original",
      prefix: "pb_test",
      tokenHash: randomUUID(),
    })
    .returning();
  await assert.rejects(resolveProject(orgB.slug, projectA.id, b.actor), notFound);
  for (const run of [
    () => getProject(orgB.slug, projectA.id),
    () => listKeys(orgB.slug, projectA.id),
    () => getRealtime(orgB.slug, projectA.id),
    () => getReport(orgB.slug, projectA, 7),
    () =>
      firstEvent(new Request(`${process.env.APP_URL}/api/projects/${projectA.id}/first-event`), {
        params: Promise.resolve({ id: projectA.id }),
      }),
    () =>
      realtime(new Request(`${process.env.APP_URL}/api/projects/${projectA.id}/realtime`), {
        params: Promise.resolve({ id: projectA.id }),
      }),
    () =>
      legacy(new Request(`${process.env.APP_URL}/projects/${projectA.id}`), {
        params: Promise.resolve({ id: projectA.id }),
      }),
    () =>
      actions.createKeyAction({}, form({ org: orgB.slug, projectId: projectA.id, name: "Stolen" })),
    () => actions.revokeKeyAction(form({ org: orgB.slug, projectId: projectB.id, id: key.id })),
  ])
    await assert.rejects(asUser<Promise<unknown>>(b.cookie, run), notFound);
  const visible = await asUser(b.cookie, () => listProjects(orgB.slug));
  assert.deepEqual(
    visible.map((project) => project.id),
    [projectB.id],
  );
  assert.deepEqual(
    (await asUser(b.cookie, () => getPortfolio(orgB.slug))).map((project) => project.id),
    [projectB.id],
  );
  await db
    .insert(member)
    .values({ organizationId: orgA.id, userId: b.actor.id, role: "member", createdAt: new Date() });
  assert.equal((await asUser(b.cookie, () => getProject(orgA.slug, projectA.id))).id, projectA.id);
  const values = {
    org: orgA.slug,
    id: projectA.id,
    name: "Changed",
    origins: "https://other.example",
    timezone: "UTC",
    retentionDays: "7",
    paused: "on",
    confirmation: projectA.name,
  };
  for (const run of [
    () => actions.saveProjectAction({}, form(values)),
    () => actions.saveProjectAction({}, form({ ...values, id: "" })),
    () => actions.deleteProjectAction({}, form(values)),
    () =>
      actions.createKeyAction(
        {},
        form({ org: orgA.slug, projectId: projectA.id, name: "Blocked" }),
      ),
    () => actions.revokeKeyAction(form({ org: orgA.slug, projectId: projectA.id, id: key.id })),
  ])
    await assert.rejects(asUser<Promise<unknown>>(b.cookie, run), /Only owners and admins/);
  const [unchanged] = await db.select().from(projects).where(eq(projects.id, projectA.id));
  assert.deepEqual(unchanged, projectA);
  assert.equal((await db.select().from(apiKeys).where(eq(apiKeys.id, key.id)))[0].revokedAt, null);
  assert.equal(
    (await db.select().from(auditLog).where(eq(auditLog.organizationId, orgA.id))).length,
    0,
  );
});

test("first-event status follows accepted pageviews and agent context saves atomically with its audit", async () => {
  const { actor, cookie } = await verified();
  const org = await orgFor(actor.id);
  const values = {
    org: org.slug,
    name: "Connect test",
    origins: "https://example.test",
    timezone: "UTC",
    retentionDays: "90",
  };
  const created = await asUser(cookie, () => actions.saveProjectAction({}, form(values)));
  assert.ok(created.projectId);
  const id = created.projectId;
  projectIds.push(id);
  const status = () =>
    asUser(cookie, () =>
      firstEvent(new Request(`${process.env.APP_URL}/api/projects/${id}/first-event`), {
        params: Promise.resolve({ id }),
      }),
    );
  assert.deepEqual(await (await status()).json(), { firstEventAt: null });
  assert.equal((await asUser(cookie, () => getPortfolio(org.slug)))[0].lastEvent, null);
  await assert.rejects(
    asUser("", () =>
      firstEvent(new Request(`${process.env.APP_URL}/api/projects/${id}/first-event`), {
        params: Promise.resolve({ id }),
      }),
    ),
    notFound,
  );

  const message = {
    id: randomUUID(),
    type: "heartbeat",
    path: "/",
    visitorId: randomUUID(),
    visitId: randomUUID(),
  };
  const send = (origin: string, type: string) =>
    collect(
      new Request(`${process.env.APP_URL}/api/v1/collect`, {
        method: "POST",
        headers: { origin, "Content-Type": "application/json", "x-forwarded-for": "192.0.2.8" },
        body: JSON.stringify({ projectId: id, events: [{ ...message, id: randomUUID(), type }] }),
      }),
    );
  assert.equal((await send("https://foreign.test", "pageview")).status, 403);
  assert.equal((await send(values.origins, "heartbeat")).status, 200);
  assert.deepEqual(await (await status()).json(), { firstEventAt: null });
  assert.equal((await send(values.origins, "pageview")).status, 200);
  const response = await status();
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  const received = await response.json();
  assert.ok(Number.isFinite(Date.parse(received.firstEventAt)));
  assert.ok((await asUser(cookie, () => getPortfolio(org.slug)))[0].lastEvent);
  assert.equal((await send(values.origins, "pageview")).status, 200);
  assert.deepEqual(await (await status()).json(), received);

  const multipartForm = (agentContext: string) =>
    new Request(`${process.env.APP_URL}/app/${org.slug}/projects/${id}/settings`, {
      method: "POST",
      body: form({ ...values, id, agentContext }),
    }).formData();
  const agentContext = "🙂".repeat(3998) + "\nb";
  const saved = await asUser(cookie, async () =>
    actions.saveProjectAction({}, await multipartForm(agentContext)),
  );
  assert.equal(saved.success, "Project updated.");
  assert.equal((await asUser(cookie, () => getProject(org.slug, id))).agentContext, agentContext);
  const audits = () => db.select().from(auditLog).where(eq(auditLog.organizationId, org.id));
  assert.equal((await audits()).filter((entry) => entry.action === "project.updated").length, 1);
  const rejected = await asUser(cookie, async () =>
    actions.saveProjectAction({}, await multipartForm(agentContext + "a")),
  );
  assert.equal(rejected.error, "Agent context must be at most 4,000 characters.");
  assert.equal((await asUser(cookie, () => getProject(org.slug, id))).agentContext, agentContext);
  assert.equal((await audits()).filter((entry) => entry.action === "project.updated").length, 1);
  await asUser(cookie, () =>
    actions.saveProjectAction({}, form({ ...values, id, agentContext: "" })),
  );
  assert.equal((await asUser(cookie, () => getProject(org.slug, id))).agentContext, "");
});

test("wrong email and password match; eleventh sign-in is limited independently of spoofed first IP", async () => {
  const { actor } = await verified();
  const ip = randomUUID();
  const wrongEmail = await request(
    "sign-in/email",
    { email: `absent-${randomUUID()}@example.com`, password },
    ip,
  );
  const wrongPassword = await request(
    "sign-in/email",
    { email: actor.email, password: "wrong-password" },
    ip,
  );
  assert.equal((await wrongEmail.json()).message, "Email or password is incorrect");
  assert.equal((await wrongPassword.json()).message, "Email or password is incorrect");
  for (let i = 2; i < 10; i++)
    assert.equal(
      (await request("sign-in/email", { email: actor.email, password: "wrong-password" }, ip))
        .status,
      401,
    );
  const limited = await request("sign-in/email", { email: actor.email, password }, ip);
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).message, ATTEMPT_LIMIT_MESSAGE);
  assert.equal(
    (await request("sign-in/email", { email: actor.email, password }, randomUUID())).status,
    200,
  );
});

test("organization slugs are unique and reserved names are avoided; ownership is limited and deletion cascades", async () => {
  const { actor } = await verified();
  const created = await Promise.all(Array.from({ length: 5 }, () => orgFor(actor.id, "new")));
  assert.equal(new Set(created.map((org) => org.slug)).size, 5);
  assert.ok(created.every((org) => org.slug !== "new"));
  await assert.rejects(createOrganization(actor.id, "Sixth"), /at most 5/);
  const project = await projectFor(created[0].id);
  await db.transaction((tx) => deleteOrganization(tx, created[0].id));
  assert.equal((await db.select().from(projects).where(eq(projects.id, project.id))).length, 0);
});

test("sign-out invalidates the session and maintenance purges expired account rows and old audit entries", async () => {
  const { actor, cookie } = await verified();
  assert.equal((await request("sign-out", {}, undefined, cookie)).status, 200);
  assert.equal(await (await request("get-session", undefined, undefined, cookie)).json(), null);
  const org = await orgFor(actor.id);
  const [expired] = await db
    .insert(session)
    .values({
      userId: actor.id,
      token: randomUUID(),
      expiresAt: new Date(0),
      updatedAt: new Date(),
    })
    .returning();
  const [proof] = await db
    .insert(verification)
    .values({ identifier: randomUUID(), value: "expired", expiresAt: new Date(0) })
    .returning();
  const [audit] = await db
    .insert(auditLog)
    .values({
      organizationId: org.id,
      actorUserId: actor.id,
      actorLabel: actor.name,
      action: "test",
      targetType: "project",
      targetId: randomUUID(),
      createdAt: new Date(0),
    })
    .returning();
  const { purgeMaintenance } = await import("../../src/server/jobs/cleanup");
  await purgeMaintenance(db.$client);
  assert.equal((await db.select().from(session).where(eq(session.id, expired.id))).length, 0);
  assert.equal(
    (await db.select().from(verification).where(eq(verification.id, proof.id))).length,
    0,
  );
  assert.equal((await db.select().from(auditLog).where(eq(auditLog.id, audit.id))).length, 0);
});

test("successful project and ingest-key mutations record the actor and preserve the deletion audit", async () => {
  const { actor, cookie } = await verified();
  const org = await orgFor(actor.id);
  const values = {
    org: org.slug,
    name: "Audited",
    origins: "https://example.com",
    timezone: "UTC",
    retentionDays: "90",
  };
  const created = await asUser(cookie, () => actions.saveProjectAction({}, form(values)));
  assert.ok(created.projectId);
  const id = created.projectId;
  projectIds.push(id);
  await asUser(cookie, () => actions.saveProjectAction({}, form({ ...values, id, paused: "on" })));
  await asUser(cookie, () => actions.saveProjectAction({}, form({ ...values, id })));
  await asUser(cookie, () =>
    actions.createKeyAction({}, form({ org: org.slug, projectId: id, name: "Audited key" })),
  );
  const [key] = await db.select().from(apiKeys).where(eq(apiKeys.projectId, id));
  await asUser(cookie, () =>
    actions.revokeKeyAction(form({ org: org.slug, projectId: id, id: key.id })),
  );
  await assert.rejects(
    asUser(cookie, () =>
      actions.deleteProjectAction({}, form({ org: org.slug, id, confirmation: values.name })),
    ),
    (error: unknown) =>
      error instanceof Error &&
      "digest" in error &&
      String(error.digest).startsWith("NEXT_REDIRECT;"),
  );
  const entries = await db.select().from(auditLog).where(eq(auditLog.organizationId, org.id));
  for (const action of [
    "project.created",
    "project.updated",
    "project.paused",
    "project.resumed",
    "project.deleted",
    "ingest_key.created",
    "ingest_key.revoked",
  ]) {
    assert.ok(
      entries.some((entry) => entry.action === action),
      action,
    );
  }
  assert.ok(
    entries.every(
      (entry) =>
        entry.actorUserId === actor.id &&
        entry.actorLabel.includes(actor.name) &&
        entry.actorLabel.includes(actor.email),
    ),
  );
  assert.equal((await db.select().from(apiKeys).where(eq(apiKeys.id, key.id))).length, 0);
});

test("sixth signup from one final forwarded address is refused and unmounted plugin routes cannot bypass policy", async () => {
  const ip = randomUUID();
  for (let i = 0; i < 5; i++) {
    const email = `limited-${randomUUID()}@example.com`;
    emails.push(email);
    assert.equal(
      (
        await request(
          "sign-up/email",
          { email, password, name: "Limited", termsAccepted: true },
          ip,
        )
      ).status,
      200,
    );
    const [actor] = await db.select().from(user).where(eq(user.email, email));
    userIds.push(actor.id);
  }
  const denied = `limited-${randomUUID()}@example.com`;
  assert.equal(
    (
      await request(
        "sign-up/email",
        { email: denied, password, name: "Limited", termsAccepted: true },
        ip,
      )
    ).status,
    429,
  );
  assert.equal((await db.select().from(user).where(eq(user.email, denied))).length, 0);
  assert.equal((await request("organization/create", { name: "Bypass", slug: "new" })).status, 404);
});

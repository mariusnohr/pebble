import "next/dist/server/node-environment-baseline.js";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq, inArray } from "drizzle-orm";
import { getDb, closeDb } from "../../src/db";
import {
  invitation,
  auditLog,
  emailOutbox,
  member,
  organization,
  projects,
  user,
} from "../../src/db/schema";
import { requireTestDatabaseUrl } from "../../scripts/rehearse-cutover";
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
const { createOrganization } = await import("../../src/server/organizations");
const actions = await import("../../src/server/actions");
const { default: AppPage } = await import("../../src/app/app/page");
const { memberAction, invitationResponseAction } = await import("../../src/server/member-actions");
const {
  inviteMember,
  manageInvitation,
  respondToInvitation,
  changeMembership,
  transferOwnership,
  pendingInvitations,
  invitationUnavailable,
} = await import("../../src/server/members");
const { getProject } = await import("../../src/server/queries");
const { signupAllowed } = await import("../../src/server/signup-gate");
const { purgeMaintenance } = await import("../../src/server/jobs/cleanup");
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

async function membership(orgId: string, userId: string) {
  return (await db.select().from(member).where(eq(member.organizationId, orgId))).find(
    (row) => row.userId === userId,
  )!;
}
async function addMember(orgId: string, userId: string, role = "member") {
  const [row] = await db
    .insert(member)
    .values({ organizationId: orgId, userId, role, createdAt: new Date() })
    .returning();
  return row;
}

test("admin invitation opens the closed launch gate, verification routes to invitations, and acceptance joins once", async () => {
  const owner = await verified(),
    admin = await verified();
  const org = await orgFor(owner.actor.id);
  await addMember(org.id, admin.actor.id, "admin");
  const email = `invited-${randomUUID()}@example.com`;
  const result = await asUser(admin.cookie, () =>
    memberAction(
      {},
      form({ org: org.slug, operation: "invite", email: email.toUpperCase(), role: "admin" }),
    ),
  );
  assert.equal(result.success, "Invitation sent.");
  const [invite] = await pendingInvitations(email.toUpperCase());
  assert.ok(invite);
  const [mail] = await db.select().from(emailOutbox).where(eq(emailOutbox.to, email));
  assert.equal(mail.template, "invitation");
  assert.equal(
    (mail.payload as { links: { path: string }[] }).links[0].path,
    `/invite/${invite.id}`,
  );
  assert.ok(Math.abs(invite.expiresAt.getTime() - Date.now() - 7 * 86400000) < 10000);
  delete process.env.SIGNUP_OPEN;
  try {
    const blocked = await request("sign-up/email", {
      name: "Blocked",
      email: `blocked-${randomUUID()}@example.com`,
      password,
      termsAccepted: true,
    });
    assert.equal(blocked.status, 403);
    const invited = await verified(email.toUpperCase());
    await assert.rejects(
      asUser(invited.cookie, () => AppPage()),
      redirectedTo("/app/invitations"),
    );
    await assert.rejects(
      asUser(invited.cookie, () =>
        invitationResponseAction({}, form({ id: invite.id, response: "accept" })),
      ),
      redirectedTo(`/app/${org.slug}`),
    );
    assert.equal((await resolveOrganization(org.slug, invited.actor)).role, "admin");
    assert.equal((await pendingInvitations(email)).length, 0);
    await assert.rejects(respondToInvitation(invited.actor, invite.id, true), /already been used/);
    const row = (await db.select().from(invitation).where(eq(invitation.id, invite.id)))[0];
    assert.ok(row.acceptedAt);
    const entries = await audits(org.id);
    assert.deepEqual(entries.map((entry) => entry.action).sort(), [
      "member.invited",
      "member.joined",
    ]);
    assert.equal(
      entries.find((entry) => entry.action === "member.invited")!.actorUserId,
      admin.actor.id,
    );
    assert.equal(
      entries.find((entry) => entry.action === "member.joined")!.actorUserId,
      invited.actor.id,
    );
    for (const entry of entries) assert.match(entry.actorLabel!, /Test account <.+@example.com>/);
  } finally {
    process.env.SIGNUP_OPEN = "true";
  }
});

test("only the matching verified email can respond; duplicate invitations, existing members and expired links are refused", async () => {
  const owner = await verified(),
    invited = await verified(),
    other = await verified();
  const org = await orgFor(owner.actor.id);
  const invite = await inviteMember(
    owner.actor,
    org.slug,
    invited.actor.email.toUpperCase(),
    "member",
  );
  await assert.rejects(
    inviteMember(owner.actor, org.slug, invited.actor.email, "admin"),
    /pending invitation/,
  );
  await assert.rejects(
    inviteMember(owner.actor, org.slug, owner.actor.email.toUpperCase(), "member"),
    /already a member/,
  );
  await assert.rejects(
    inviteMember(owner.actor, org.slug, other.actor.email, "owner"),
    /admin or member/,
  );
  for (const accept of [true, false])
    await assert.rejects(respondToInvitation(other.actor, invite.id, accept), /verified address/);
  await db.update(user).set({ emailVerified: false }).where(eq(user.id, invited.actor.id));
  await assert.rejects(respondToInvitation(invited.actor, invite.id, true), /Verify your email/);
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, invited.actor.id));
  await db
    .update(invitation)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(invitation.id, invite.id));
  await assert.rejects(
    respondToInvitation(invited.actor, invite.id, true),
    /This invitation has expired/,
  );
  assert.equal(
    invitationUnavailable({ ...invite, expiresAt: new Date(0) }),
    "This invitation has expired",
  );
  assert.equal((await pendingInvitations(invited.actor.email)).length, 0);
  assert.equal((await audits(org.id)).length, 1);
  const replacement = await inviteMember(owner.actor, org.slug, invited.actor.email, "member");
  await respondToInvitation(invited.actor, replacement.id, false);
  await assert.rejects(respondToInvitation(invited.actor, replacement.id, true), /declined/);
  assert.equal((await audits(org.id)).at(-1)!.action, "invitation.declined");
});

test("resends are atomic, capped at three per UTC day, retain expiry, and revocation prevents acceptance and signup", async () => {
  const owner = await verified(),
    invited = await verified();
  const org = await orgFor(owner.actor.id);
  const invite = await inviteMember(owner.actor, org.slug, invited.actor.email, "member");
  const resends = await Promise.allSettled(
    Array.from({ length: 4 }, () => manageInvitation(owner.actor, org.slug, invite.id, "resend")),
  );
  assert.equal(resends.filter((result) => result.status === "fulfilled").length, 3);
  const rejected = resends.find((result) => result.status === "rejected")!;
  assert.match(String(rejected.reason), /3 times today/);
  let row = (await db.select().from(invitation).where(eq(invitation.id, invite.id)))[0];
  assert.equal(row.resendCount, 3);
  assert.equal(row.expiresAt.getTime(), invite.expiresAt.getTime());
  await db
    .update(invitation)
    .set({ resendAt: new Date(Date.now() - 86400000) })
    .where(eq(invitation.id, invite.id));
  await manageInvitation(owner.actor, org.slug, invite.id, "resend");
  row = (await db.select().from(invitation).where(eq(invitation.id, invite.id)))[0];
  assert.equal(row.resendCount, 1);
  assert.equal(
    (await db.select().from(emailOutbox).where(eq(emailOutbox.to, invited.actor.email))).filter(
      (mail) => mail.template === "invitation",
    ).length,
    5,
  );
  await manageInvitation(owner.actor, org.slug, invite.id, "revoke");
  await assert.rejects(respondToInvitation(invited.actor, invite.id, true), /revoked/);
  await assert.rejects(manageInvitation(owner.actor, org.slug, invite.id, "resend"), /revoked/);
  assert.equal((await pendingInvitations(invited.actor.email)).length, 0);
  delete process.env.SIGNUP_OPEN;
  try {
    assert.equal(await signupAllowed(invited.actor.email), false);
  } finally {
    process.env.SIGNUP_OPEN = "true";
  }
  const entries = await audits(org.id);
  assert.equal(entries.filter((entry) => entry.action === "invitation.resent").length, 4);
  assert.ok(entries.every((entry) => entry.actorUserId === owner.actor.id));
  assert.equal(entries.at(-1)!.action, "invitation.revoked");
});

test("competing invitations and acceptance have only one winner", async () => {
  const owner = await verified(),
    invited = await verified();
  const org = await orgFor(owner.actor.id);
  const results = await Promise.allSettled([
    inviteMember(owner.actor, org.slug, invited.actor.email, "member"),
    inviteMember(owner.actor, org.slug, invited.actor.email.toUpperCase(), "admin"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const [invite] = await pendingInvitations(invited.actor.email);
  const accepts = await Promise.allSettled([
    respondToInvitation(invited.actor, invite.id, true),
    respondToInvitation(invited.actor, invite.id, true),
  ]);
  assert.equal(accepts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    (await audits(org.id)).filter((entry) => entry.action === "member.joined").length,
    1,
  );
});

test("members cannot mutate memberships or projects; owner is protected; removal and leaving revoke access immediately", async () => {
  const owner = await verified(),
    admin = await verified(),
    reader = await verified();
  const org = await orgFor(owner.actor.id);
  const ownerMember = await membership(org.id, owner.actor.id);
  const adminMember = await addMember(org.id, admin.actor.id, "admin");
  const readerMember = await addMember(org.id, reader.actor.id);
  const project = await projectFor(org.id);
  const invite = await inviteMember(
    owner.actor,
    org.slug,
    `pending-${randomUUID()}@example.com`,
    "member",
  );
  emails.push(invite.email);
  for (const operation of ["invite", "role", "remove", "resend", "revoke"]) {
    const result = await asUser(reader.cookie, () =>
      memberAction(
        {},
        form({
          org: org.slug,
          operation,
          id: ["resend", "revoke"].includes(operation) ? invite.id : adminMember.id,
          email: `new-${randomUUID()}@example.com`,
          role: "admin",
        }),
      ),
    );
    assert.match(result.error!, /Only owners and admins/);
  }
  await assert.rejects(
    asUser(reader.cookie, () =>
      actions.createKeyAction(
        {},
        form({ org: org.slug, projectId: project.id, name: "Forbidden" }),
      ),
    ),
    /Only owners and admins/,
  );
  await assert.rejects(
    asUser(reader.cookie, () =>
      actions.deleteProjectAction(
        {},
        form({ org: org.slug, id: project.id, confirmation: project.name }),
      ),
    ),
    /Only owners and admins/,
  );
  await assert.rejects(
    asUser(reader.cookie, () => requireOrganizationSettings(org.slug)),
    notFound,
  );
  for (const actor of [owner.actor, admin.actor]) {
    await assert.rejects(
      changeMembership(actor, org.slug, ownerMember.id, "role", "admin"),
      /owner cannot/,
    );
    await assert.rejects(
      changeMembership(actor, org.slug, ownerMember.id, "remove"),
      /owner cannot/,
    );
  }
  await assert.rejects(
    changeMembership(owner.actor, org.slug, ownerMember.id, "leave"),
    /owner cannot/,
  );
  await assert.rejects(
    changeMembership(reader.actor, org.slug, adminMember.id, "leave"),
    /only leave for yourself/,
  );
  assert.equal((await audits(org.id)).length, 1);
  await changeMembership(admin.actor, org.slug, readerMember.id, "role", "admin");
  assert.equal((await resolveOrganization(org.slug, reader.actor)).role, "admin");
  await changeMembership(owner.actor, org.slug, readerMember.id, "role", "member");
  await changeMembership(admin.actor, org.slug, readerMember.id, "remove");
  await assert.rejects(resolveOrganization(org.slug, reader.actor), notFound);
  await assert.rejects(
    asUser(reader.cookie, () => getProject(org.slug, project.id)),
    notFound,
  );
  await assert.rejects(
    asUser(reader.cookie, () =>
      memberAction({}, form({ org: org.slug, operation: "leave", id: readerMember.id })),
    ),
    notFound,
  );
  await assert.rejects(
    asUser(admin.cookie, () =>
      memberAction({}, form({ org: org.slug, operation: "leave", id: adminMember.id })),
    ),
    redirectedTo("/app"),
  );
  await assert.rejects(resolveOrganization(org.slug, admin.actor), notFound);
  const entries = await audits(org.id);
  assert.deepEqual(entries.map((entry) => entry.action).sort(), [
    "member.invited",
    "member.left",
    "member.removed",
    "member.role_changed",
    "member.role_changed",
  ]);
  assert.equal(
    entries.find((entry) => entry.action === "member.removed")!.actorUserId,
    admin.actor.id,
  );
  assert.equal(
    entries.find((entry) => entry.action === "member.left")!.actorUserId,
    admin.actor.id,
  );
});

test("ownership transfer requires the owner password and an existing admin, swaps roles and queues both emails", async () => {
  const owner = await verified(),
    admin = await verified(),
    reader = await verified();
  const org = await orgFor(owner.actor.id);
  const adminMember = await addMember(org.id, admin.actor.id, "admin");
  const readerMember = await addMember(org.id, reader.actor.id);
  await assert.rejects(
    transferOwnership(admin.actor, org.slug, adminMember.id, password),
    /Only the owner/,
  );
  await assert.rejects(
    transferOwnership(owner.actor, org.slug, adminMember.id, "incorrect-password"),
    /Password is incorrect/,
  );
  await assert.rejects(
    transferOwnership(owner.actor, org.slug, readerMember.id, password),
    /existing admin/,
  );
  const otherOrg = await orgFor(reader.actor.id);
  await assert.rejects(
    transferOwnership(
      owner.actor,
      org.slug,
      (await membership(otherOrg.id, reader.actor.id)).id,
      password,
    ),
    /existing admin/,
  );
  assert.equal((await audits(org.id)).length, 0);
  assert.equal((await resolveOrganization(org.slug, owner.actor)).role, "owner");
  const result = await asUser(owner.cookie, () =>
    memberAction({}, form({ org: org.slug, operation: "transfer", id: adminMember.id, password })),
  );
  assert.match(result.success!, /Ownership transferred/);
  assert.equal((await resolveOrganization(org.slug, owner.actor)).role, "admin");
  assert.equal((await resolveOrganization(org.slug, admin.actor)).role, "owner");
  for (const actor of [owner.actor, admin.actor]) {
    const mail = (
      await db.select().from(emailOutbox).where(eq(emailOutbox.to, actor.email))
    ).filter((row) => row.template === "ownershipTransferred");
    assert.equal(mail.length, 1);
    assert.equal((mail[0].payload as { organizationName: string }).organizationName, org.name);
  }
  const [audit] = await audits(org.id);
  assert.equal(audit.action, "ownership.transferred");
  assert.equal(audit.actorUserId, owner.actor.id);
  assert.deepEqual(audit.details, { from: owner.actor.id, to: admin.actor.id });
  await assert.rejects(
    changeMembership(owner.actor, org.slug, adminMember.id, "remove"),
    /owner cannot/,
  );
});

test("daily purge retains invitations until 30 days after expiry or acceptance", async () => {
  const owner = await verified();
  const org = await orgFor(owner.actor.id);
  const day = 86400000;
  const rows = await db
    .insert(invitation)
    .values(
      [
        { status: "pending", expiresAt: new Date(Date.now() - 31 * day) },
        { status: "revoked", expiresAt: new Date(Date.now() - 31 * day) },
        {
          status: "accepted",
          expiresAt: new Date(Date.now() - 25 * day),
          acceptedAt: new Date(Date.now() - 31 * day),
        },
        {
          status: "accepted",
          expiresAt: new Date(Date.now() - 25 * day),
          acceptedAt: new Date(Date.now() - 29 * day),
        },
        { status: "pending", expiresAt: new Date(Date.now() - 29 * day) },
      ].map((row) => ({
        ...row,
        organizationId: org.id,
        inviterId: owner.actor.id,
        email: `purge-${randomUUID()}@example.com`,
        role: "member",
      })),
    )
    .returning();
  await purgeMaintenance(db.$client);
  const retained = await db.select().from(invitation).where(eq(invitation.organizationId, org.id));
  assert.deepEqual(
    retained.map((row) => row.id).sort(),
    rows
      .slice(3)
      .map((row) => row.id)
      .sort(),
  );
});

test("a member can leave but cannot use another organization's member or invitation IDs", async () => {
  const owner = await verified(),
    reader = await verified();
  const org = await orgFor(owner.actor.id),
    other = await orgFor(owner.actor.id);
  const person = await addMember(org.id, reader.actor.id);
  const otherPerson = await addMember(other.id, reader.actor.id);
  const invite = await inviteMember(
    owner.actor,
    other.slug,
    `other-${randomUUID()}@example.com`,
    "member",
  );
  emails.push(invite.email);
  await assert.rejects(
    changeMembership(owner.actor, org.slug, otherPerson.id, "remove"),
    /no longer a member/,
  );
  await assert.rejects(
    manageInvitation(owner.actor, org.slug, invite.id, "revoke"),
    /no longer available/,
  );
  await assert.rejects(
    asUser(reader.cookie, () =>
      memberAction({}, form({ org: org.slug, operation: "leave", id: person.id })),
    ),
    redirectedTo("/app"),
  );
  await assert.rejects(
    asUser(reader.cookie, () => getProject(org.slug, randomUUID())),
    notFound,
  );
  assert.equal((await resolveOrganization(other.slug, reader.actor)).role, "member");
  const [entry] = await audits(org.id);
  assert.equal(entry.action, "member.left");
  assert.equal(entry.actorUserId, reader.actor.id);
  await assert.rejects(
    asUser(reader.cookie, () =>
      memberAction(
        {},
        form({ org: org.slug, operation: "invite", email: "x@example.com", role: "member" }),
      ),
    ),
    notFound,
  );
});

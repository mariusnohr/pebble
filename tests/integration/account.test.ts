import "next/dist/server/node-environment-baseline.js";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getDb, closeDb } from "../../src/db";
import {
  account,
  emailOutbox,
  member,
  organization,
  projects,
  session,
  twoFactor,
  user,
  verification,
} from "../../src/db/schema";
import { requireTestDatabaseUrl } from "../../scripts/rehearse-cutover";

process.env.DATABASE_URL = requireTestDatabaseUrl(process.env.TEST_DATABASE_URL);
process.env.APP_URL = "http://localhost:3000";
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.TRUST_PROXY = "true";
process.env.SIGNUP_OPEN = "true";
const { handleAuth, ATTEMPT_LIMIT_MESSAGE } = await import("../../src/server/auth-handler");
const { createOrganization } = await import("../../src/server/organizations");
const db = getDb();
const emails: string[] = [],
  userIds: string[] = [],
  orgIds: string[] = [];
const password = "pebble-account-test-password";
const replacement = "a-new-pebble-test-password";

// Each instance is a separate browser cookie jar, including replacement/expired cookies.
class Browser {
  cookies = new Map<string, string>();
  agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36";
  async request(path: string, body?: Record<string, unknown>, origin = process.env.APP_URL!) {
    const response = await handleAuth(
      new Request(`${process.env.APP_URL}/api/auth/${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          origin,
          "Content-Type": "application/json",
          "x-forwarded-for": randomUUID(),
          "user-agent": this.agent,
          cookie: Array.from(this.cookies, ([key, value]) => `${key}=${value}`).join("; "),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0];
      const split = pair.indexOf("=");
      const name = pair.slice(0, split),
        value = pair.slice(split + 1);
      if (/max-age=0/i.test(cookie) || !value) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }
  async signIn(email: string, credential = password) {
    const response = await this.request("sign-in/email", { email, password: credential });
    assert.equal(response.status, 200);
    return response.json();
  }
  async current() {
    return (await this.request("get-session")).json();
  }
}
async function setup() {
  const browser = new Browser();
  const email = `security-${randomUUID()}@example.com`;
  emails.push(email);
  const signup = await browser.request("sign-up/email", {
    name: "Security test",
    email,
    password,
    termsAccepted: true,
  });
  assert.equal(signup.status, 200);
  const [actor] = await db.select().from(user).where(eq(user.email, email));
  userIds.push(actor.id);
  const token = await mailToken(email, "verifyEmail");
  assert.equal((await browser.request(`verify-email?token=${token}`)).status, 200);
  return { browser, actor };
}
async function mails(email: string, template: string) {
  return db
    .select()
    .from(emailOutbox)
    .where(and(eq(emailOutbox.to, email), eq(emailOutbox.template, template)))
    .orderBy(asc(emailOutbox.createdAt));
}
async function mailToken(email: string, template = "passwordReset") {
  const rows = await mails(email, template);
  assert.ok(rows.length);
  const payload = rows.at(-1)!.payload as { links: { path: string }[] };
  return new URL(payload.links[0].path, process.env.APP_URL).searchParams.get("token")!;
}
// Independent RFC 6238 implementation for exercising the actual Better Auth verifier.
function totp(uri: string) {
  const secret = new URL(uri).searchParams.get("secret")!;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret.toUpperCase().replace(/=+$/, "")]
    .map((char) => alphabet.indexOf(char).toString(2).padStart(5, "0"))
    .join("");
  const bytes = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac("sha1", bytes).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, "0");
}
async function enable(browser: Browser) {
  const response = await browser.request("two-factor/enable", { password });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.backupCodes, undefined);
  const confirm = await browser.request("two-factor/verify-totp", { code: totp(data.totpURI) });
  assert.equal(confirm.status, 200);
  const { backupCodes } = await confirm.json();
  assert.equal(backupCodes.length, 10);
  assert.equal(new Set(backupCodes).size, 10);
  return { uri: data.totpURI as string, codes: backupCodes as string[] };
}

before(async () => {
  await migrate(db, { migrationsFolder: "drizzle" });
});
after(async () => {
  if (orgIds.length) await db.delete(organization).where(inArray(organization.id, orgIds));
  if (userIds.length) {
    await db.delete(verification).where(inArray(verification.value, userIds));
    await db.delete(user).where(inArray(user.id, userIds));
  }
  if (emails.length) await db.delete(emailOutbox).where(inArray(emailOutbox.to, emails));
  await closeDb();
});

test("forgot-password is uniform, normalizes email and permits only three requests per hour", async () => {
  const { actor } = await setup();
  const browser = new Browser();
  const missing = `missing-${randomUUID()}@example.com`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const known = await browser.request("request-password-reset", {
      email: ` ${actor.email.toUpperCase()} `,
      redirectTo: "https://attacker.invalid",
    });
    const unknown = await browser.request("request-password-reset", { email: missing });
    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    assert.deepEqual(await known.json(), await unknown.json());
  }
  for (const email of [actor.email, missing]) {
    const limited = await browser.request("request-password-reset", { email });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).message, ATTEMPT_LIMIT_MESSAGE);
  }
  const queued = await mails(actor.email, "passwordReset");
  assert.equal(queued.length, 3);
  assert.equal((await mails(missing, "passwordReset")).length, 0);
  const links = queued[0].payload.links as { path: string }[];
  assert.match(links[0].path, /^\/reset-password\?token=/);
});

test("reset expires in one hour, is single-use, revokes all browsers and queues one notice", async () => {
  const { actor, browser } = await setup();
  const second = new Browser();
  await second.signIn(actor.email);
  const anonymous = new Browser();
  assert.equal(
    (await anonymous.request("request-password-reset", { email: actor.email })).status,
    200,
  );
  const token = await mailToken(actor.email);
  const [stored] = await db
    .select()
    .from(verification)
    .where(eq(verification.identifier, `reset-password:${token}`));
  const lifetime = stored.expiresAt.getTime() - stored.createdAt.getTime();
  assert.ok(Math.abs(lifetime - 3600000) < 5000);
  assert.equal(
    (await anonymous.request("reset-password", { token, newPassword: replacement })).status,
    200,
  );
  assert.equal(
    (await anonymous.request("reset-password", { token, newPassword: password })).status,
    400,
  );
  assert.equal(await browser.current(), null);
  assert.equal(await second.current(), null);
  assert.equal((await mails(actor.email, "passwordChanged")).length, 1);
  assert.equal(
    (await browser.request("sign-in/email", { email: actor.email, password })).status,
    401,
  );
  await browser.signIn(actor.email, replacement);
  await anonymous.request("request-password-reset", { email: actor.email });
  const expired = await mailToken(actor.email);
  await db
    .update(verification)
    .set({ expiresAt: new Date(Date.now() - 1) })
    .where(eq(verification.identifier, `reset-password:${expired}`));
  assert.equal(
    (await anonymous.request("reset-password", { token: expired, newPassword: password })).status,
    400,
  );
  assert.ok(await browser.current());
});

test("concurrent reset redemption succeeds once and invalidates every other reset link", async () => {
  const { actor } = await setup();
  const anonymous = new Browser();
  await anonymous.request("request-password-reset", { email: actor.email });
  const first = await mailToken(actor.email);
  await anonymous.request("request-password-reset", { email: actor.email });
  const second = await mailToken(actor.email);
  const results = await Promise.all(
    [new Browser(), new Browser()].map((b) =>
      b.request("reset-password", { token: first, newPassword: replacement }),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
  assert.equal(
    (await anonymous.request("reset-password", { token: second, newPassword: password })).status,
    400,
  );
  assert.equal((await mails(actor.email, "passwordChanged")).length, 1);
});

test("change-password verifies the current password and optionally preserves other sessions", async () => {
  const { browser, actor } = await setup();
  const second = new Browser();
  await second.signIn(actor.email);
  const wrong = await browser.request("change-password", {
    currentPassword: "wrong-password",
    newPassword: replacement,
    revokeOtherSessions: true,
  });
  assert.equal(wrong.status, 400);
  assert.equal((await mails(actor.email, "passwordChanged")).length, 0);
  assert.ok(await second.current());
  assert.equal(
    (
      await browser.request("change-password", {
        currentPassword: password,
        newPassword: replacement,
        revokeOtherSessions: false,
      })
    ).status,
    200,
  );
  assert.ok(await second.current());
  assert.equal(
    (
      await browser.request("change-password", {
        currentPassword: replacement,
        newPassword: password,
        revokeOtherSessions: true,
      })
    ).status,
    200,
  );
  assert.equal(await second.current(), null);
  assert.ok(await browser.current());
  assert.equal((await mails(actor.email, "passwordChanged")).length, 2);
});

test("session list exposes summaries, tracks activity, and revokes only another owned session", async () => {
  const { browser, actor } = await setup();
  const second = new Browser();
  second.agent =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1";
  await second.signIn(actor.email);
  const outsider = await setup();
  const outsiderSession = await outsider.browser.current();
  await second.current();
  const listed = await (await browser.request("list-sessions")).json();
  assert.equal(listed.length, 2);
  const current = listed.find((row: { current: boolean }) => row.current);
  const other = listed.find((row: { current: boolean }) => !row.current);
  assert.match(other.summary, /Safari on iOS · Mobile/);
  assert.ok(other.createdAt);
  assert.ok(other.lastActiveAt);
  assert.equal(other.token, undefined);
  assert.equal(other.userAgent, undefined);
  assert.equal((await browser.request("revoke-session", { sessionId: current.id })).status, 400);
  await browser.request("revoke-session", { sessionId: outsiderSession.session.id });
  assert.ok(await outsider.browser.current());
  assert.equal((await browser.request("revoke-session", { sessionId: other.id })).status, 200);
  assert.equal(await second.current(), null);
  assert.ok(await browser.current());
  const [stored] = await db.select().from(session).where(eq(session.id, current.id));
  assert.ok(stored.lastActiveAt);
});

test("2FA requires confirmation, encrypts credentials and requires TOTP or a single-use backup code", async () => {
  const { browser, actor } = await setup();
  const { uri, codes } = await enable(browser);
  const [stored] = await db.select().from(twoFactor).where(eq(twoFactor.userId, actor.id));
  assert.notEqual(stored.secret, new URL(uri).searchParams.get("secret"));
  assert.ok(!stored.backupCodes.includes(codes[0]));
  assert.throws(() => JSON.parse(stored.backupCodes));
  const confirmAgain = await browser.request("two-factor/verify-totp", { code: totp(uri) });
  assert.equal((await confirmAgain.json()).backupCodes, undefined);
  const second = new Browser();
  assert.equal((await second.signIn(actor.email)).twoFactorRedirect, true);
  assert.equal(await second.current(), null);
  assert.equal(
    (await second.request("two-factor/verify-totp", { code: totp(uri), trustDevice: true })).status,
    200,
  );
  assert.ok(await second.current());
  const backup = new Browser();
  await backup.signIn(actor.email);
  assert.equal(
    (await backup.request("two-factor/verify-backup-code", { code: codes[0] })).status,
    200,
  );
  assert.ok(await backup.current());
  const reuse = new Browser();
  await reuse.signIn(actor.email);
  assert.equal(
    (await reuse.request("two-factor/verify-backup-code", { code: codes[0] })).status,
    401,
  );
  assert.equal(await reuse.current(), null);
  const again = await second.signIn(actor.email);
  assert.equal(again.twoFactorRedirect, true);
});

test("an incorrect setup code leaves 2FA disabled and never exposes backup codes", async () => {
  const { browser, actor } = await setup();
  const setupResponse = await browser.request("two-factor/enable", { password });
  assert.equal(setupResponse.status, 200);
  assert.equal((await setupResponse.json()).backupCodes, undefined);
  const wrong = await browser.request("two-factor/verify-totp", { code: "not-a-code" });
  assert.equal(wrong.status, 401);
  const [stored] = await db.select().from(user).where(eq(user.id, actor.id));
  assert.equal(stored.twoFactorEnabled, false);
  const second = new Browser();
  assert.equal((await second.signIn(actor.email)).twoFactorRedirect, undefined);
  assert.ok(await second.current());
});

test("sixth code attempt is refused across both factors and persists despite auth rollbacks", async () => {
  const { browser, actor } = await setup();
  const { uri } = await enable(browser);
  const second = new Browser();
  await second.signIn(actor.email);
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await second.request(
      attempt % 2 ? "two-factor/verify-backup-code" : "two-factor/verify-totp",
      { code: "not-a-valid-code" },
    );
    assert.equal(result.status, 401);
  }
  const limited = await second.request("two-factor/verify-totp", { code: totp(uri) });
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).message, ATTEMPT_LIMIT_MESSAGE);
  assert.equal(await second.current(), null);
  // A different sign-in challenge has its own budget.
  const third = new Browser();
  await third.signIn(actor.email);
  assert.equal((await third.request("two-factor/verify-totp", { code: totp(uri) })).status, 200);
});

test("concurrent backup-code redemption in different challenges succeeds only once", async () => {
  const { browser, actor } = await setup();
  const { codes } = await enable(browser);
  const browsers = [new Browser(), new Browser()];
  await Promise.all(browsers.map((b) => b.signIn(actor.email)));
  const results = await Promise.all(
    browsers.map((b) => b.request("two-factor/verify-backup-code", { code: codes[0] })),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
});

test("regeneration and disabling require passwords and invalidate old backup codes", async () => {
  const { browser, actor } = await setup();
  const { codes } = await enable(browser);
  for (const path of ["two-factor/disable", "two-factor/generate-backup-codes"]) {
    assert.equal((await browser.request(path, { password: "wrong-password" })).status, 400);
    assert.equal((await browser.request(path, {})).status, 400);
  }
  const regenerated = await browser.request("two-factor/generate-backup-codes", { password });
  assert.equal(regenerated.status, 200);
  const newCodes = (await regenerated.json()).backupCodes;
  assert.equal(newCodes.length, 10);
  const second = new Browser();
  await second.signIn(actor.email);
  assert.equal(
    (await second.request("two-factor/verify-backup-code", { code: codes[1] })).status,
    401,
  );
  assert.equal(
    (await second.request("two-factor/verify-backup-code", { code: newCodes[0] })).status,
    200,
  );
  assert.equal((await browser.request("two-factor/disable", { password })).status, 200);
  assert.equal((await db.select().from(twoFactor).where(eq(twoFactor.userId, actor.id))).length, 0);
  const third = new Browser();
  assert.equal((await third.signIn(actor.email)).twoFactorRedirect, undefined);
  assert.ok(await third.current());
});

test("password reset invalidates a pending second-factor sign-in without disabling 2FA", async () => {
  const { browser, actor } = await setup();
  const { uri } = await enable(browser);
  const pending = new Browser();
  await pending.signIn(actor.email);
  const reset = new Browser();
  await reset.request("request-password-reset", { email: actor.email });
  assert.equal(
    (
      await reset.request("reset-password", {
        token: await mailToken(actor.email),
        newPassword: replacement,
      })
    ).status,
    200,
  );
  assert.equal((await pending.request("two-factor/verify-totp", { code: totp(uri) })).status, 401);
  const fresh = new Browser();
  assert.equal((await fresh.signIn(actor.email, replacement)).twoFactorRedirect, true);
  assert.equal((await fresh.request("two-factor/verify-totp", { code: totp(uri) })).status, 200);
});

test("deletion is blocked for owners with other members; otherwise cascades sole organizations and projects", async () => {
  const { browser, actor } = await setup();
  const colleague = await setup();
  const second = new Browser();
  await second.signIn(actor.email);
  const sole = await createOrganization(actor.id, "Account sole team");
  orgIds.push(sole.id);
  const shared = await createOrganization(actor.id, "Account shared team");
  orgIds.push(shared.id);
  await db.insert(member).values({
    userId: colleague.actor.id,
    organizationId: shared.id,
    role: "member",
    createdAt: new Date(),
  });
  const [project] = await db
    .insert(projects)
    .values({ name: "Sole project", organizationId: sole.id, origins: ["https://example.com"] })
    .returning();
  const blocked = await browser.request("delete-user", { password, confirmation: "DELETE" });
  assert.equal(blocked.status, 400);
  assert.equal((await blocked.json()).message, "Transfer ownership or remove members first");
  assert.equal(
    (await db.select().from(organization).where(eq(organization.id, sole.id))).length,
    1,
  );
  assert.ok(await second.current());
  for (const body of [
    { confirmation: "DELETE" },
    { password, confirmation: "delete" },
    { password: "wrong-password", confirmation: "DELETE" },
    { password, token: "bypass", confirmation: "no" },
  ])
    assert.equal((await browser.request("delete-user", body)).status, 400);
  // Transferred ownership lets the departing account leave this organization intact.
  await db
    .update(member)
    .set({ role: "member" })
    .where(and(eq(member.organizationId, shared.id), eq(member.userId, actor.id)));
  await db
    .update(member)
    .set({ role: "owner" })
    .where(and(eq(member.organizationId, shared.id), eq(member.userId, colleague.actor.id)));
  assert.equal(
    (await browser.request("delete-user", { password, confirmation: "DELETE" })).status,
    200,
  );
  for (const [table, condition] of [
    [user, eq(user.id, actor.id)],
    [account, eq(account.userId, actor.id)],
    [session, eq(session.userId, actor.id)],
    [organization, eq(organization.id, sole.id)],
    [projects, eq(projects.id, project.id)],
  ] as const)
    assert.equal((await db.select().from(table).where(condition)).length, 0);
  assert.equal(
    (await db.select().from(organization).where(eq(organization.id, shared.id))).length,
    1,
  );
  assert.equal(await browser.current(), null);
  assert.equal(await second.current(), null);
});

test("account endpoints reject unauthenticated and cross-origin requests; unrelated auth routes remain closed", async () => {
  const anonymous = new Browser();
  for (const path of [
    "change-password",
    "two-factor/enable",
    "two-factor/disable",
    "two-factor/generate-backup-codes",
    "revoke-session",
  ])
    assert.equal((await anonymous.request(path, { password })).status, 401);
  assert.equal(
    (await anonymous.request("delete-user", { password, confirmation: "DELETE" })).status,
    401,
  );
  assert.equal((await anonymous.request("list-sessions")).status, 401);
  const { browser } = await setup();
  assert.equal(
    (
      await browser.request(
        "delete-user",
        { password, confirmation: "DELETE" },
        "https://attacker.invalid",
      )
    ).status,
    403,
  );
  for (const path of [
    "two-factor/view-backup-codes",
    "two-factor/get-totp-uri",
    "change-email",
    "delete-user/callback",
    "organization/delete",
  ])
    assert.equal((await browser.request(path, {})).status, 404);
});

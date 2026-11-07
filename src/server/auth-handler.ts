import "server-only";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { constantTimeEqual, makeSignature, verifyJWT } from "better-auth/crypto";
import { createCookieGetter, parseCookies } from "better-auth/cookies";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { user, verification } from "@/db/schema";
import { auth, authOptions, makeAuthOptions } from "./auth-options";
import { appOrigin } from "./config";
import { accountRateLimit, clientAddress, rateLimit } from "./rate-limit";
import {
  listAccountSessions,
  passwordChanged,
  revokeAccountSession,
  touchSession,
} from "./account-security";
import { signupAllowed } from "./signup-gate";
import { readJson } from "./http";

export const ATTEMPT_LIMIT_MESSAGE = "Too many attempts. Try again in a few minutes.";
const fail = (message: string, status = 400, code = "INVALID_REQUEST") =>
  Response.json({ message, code }, { status });
const postPaths = new Set([
  "/sign-up/email",
  "/sign-in/email",
  "/sign-out",
  "/send-verification-email",
  "/request-password-reset",
  "/reset-password",
  "/change-password",
  "/revoke-session",
  "/delete-user",
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/generate-backup-codes",
]);
const getPaths = new Set(["/get-session", "/verify-email", "/list-sessions"]);
const accountPaths = new Set([
  "/change-password",
  "/list-sessions",
  "/revoke-session",
  "/delete-user",
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/generate-backup-codes",
]);
class RollbackResponse {
  constructor(readonly response: Response) {}
}

async function twoFactorChallenge(headers: Headers) {
  const name = createCookieGetter(authOptions)("two_factor").name;
  const signed = parseCookies(headers.get("cookie") ?? "").get(name);
  if (!signed) return null;
  const split = signed.lastIndexOf(".");
  if (split < 1) return null;
  const value = signed.slice(0, split);
  const expected = await makeSignature(value, process.env.BETTER_AUTH_SECRET!);
  return constantTimeEqual(signed.slice(split + 1), expected) ? value : null;
}

// Only mount features that have shipped. In particular the organization's plugin
// CRUD routes cannot bypass Pebble's roles, reserved slugs or ownership limit.
export async function handleAuth(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/auth/, "");
  if (
    !(request.method === "POST" ? postPaths : request.method === "GET" ? getPaths : new Set()).has(
      path,
    )
  )
    return fail("Not found", 404);
  if (!process.env.BETTER_AUTH_SECRET || !process.env.DATABASE_URL)
    return fail("Account sign-in is not configured.", 503);
  if (request.method === "POST" && request.headers.get("origin") !== appOrigin())
    return fail("Invalid request origin.", 403);
  let body: Record<string, unknown> = {};
  if (request.method === "POST") {
    try {
      body = await readJson(request, 8192);
    } catch {
      return fail("Invalid request.");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return fail("Invalid request.");
    if (typeof body.email === "string") body.email = body.email.trim().toLowerCase();
  }
  if (path === "/sign-up/email") {
    const parsed = z
      .object({
        email: z.email(),
        name: z.string().trim().min(1).max(80),
        password: z.string().min(10).max(128),
        termsAccepted: z.literal(true),
      })
      .safeParse(body);
    if (!parsed.success)
      return fail(
        "Enter a name (1–80 characters), valid email and password (10–128 characters), and accept the Terms and Privacy Policy.",
      );
    if (!signupAllowed(parsed.data.email)) return fail("Pebble isn't open for sign-up yet", 403);
    body = { ...parsed.data, callbackURL: "/app" };
    if (!(await rateLimit(`signup:${clientAddress(request.headers)}`, 5, 3600)))
      return fail(ATTEMPT_LIMIT_MESSAGE, 429);
  }
  if (path === "/sign-in/email") {
    if (!(await rateLimit(`signin:${clientAddress(request.headers)}`, 10, 300)))
      return fail(ATTEMPT_LIMIT_MESSAGE, 429);
    if (
      !z.object({ email: z.email(), password: z.string().min(1).max(128) }).safeParse(body).success
    )
      return fail("Email or password is incorrect", 401);
    body = { email: body.email, password: body.password, callbackURL: "/app" };
  }
  if (path === "/send-verification-email") {
    if (!z.email().safeParse(body.email).success) return fail("Enter a valid email address.");
    if (!(await rateLimit(`verify:${body.email}`, 3, 3600)))
      return fail(ATTEMPT_LIMIT_MESSAGE, 429);
    body = { email: body.email, callbackURL: "/app" };
  }
  if (path === "/request-password-reset") {
    if (!z.email().safeParse(body.email).success) return fail("Enter a valid email address.");
    if (!(await accountRateLimit(`reset:${body.email}`, 3, 3600)))
      return fail(ATTEMPT_LIMIT_MESSAGE, 429);
    body = { email: body.email, redirectTo: "/reset-password" };
  }
  if (path === "/reset-password") {
    const parsed = z
      .object({ token: z.string().min(1).max(256), newPassword: z.string().min(10).max(128) })
      .safeParse(body);
    if (!parsed.success) return fail("Use a valid reset link and a password of 10–128 characters.");
    body = parsed.data;
  }
  if (path === "/delete-user") {
    if (
      body.confirmation !== "DELETE" ||
      !z.string().min(1).max(128).safeParse(body.password).success
    )
      return fail("Enter your password and type DELETE to delete your account.");
    body = { password: body.password };
  }
  const isCode = path === "/two-factor/verify-totp" || path === "/two-factor/verify-backup-code";
  let challenge: string | null = null;
  if (isCode) {
    // Every sign-in requires a second factor; do not issue trusted-device cookies.
    body = { code: typeof body.code === "string" ? body.code.trim() : "" };
    challenge = await twoFactorChallenge(request.headers);
    const current = await auth.api.getSession({
      headers: request.headers,
      query: { disableRefresh: true },
    });
    const key = current?.session.id ?? challenge;
    if (!key) return fail("Sign in again to enter a code.", 401);
    // Keep this outside the auth transaction: rejected attempts must persist, and
    // waiting transactions must not exhaust the pool before the limiter can run.
    if (!(await accountRateLimit(`2fa:${key}`, 5, 300))) return fail(ATTEMPT_LIMIT_MESSAGE, 429);
  }
  // Never accept callback URLs or email-change tokens from the caller.
  url.searchParams.delete("callbackURL");
  const forwarded = new Request(url, {
    method: request.method,
    headers: request.headers,
    ...(request.method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
  try {
    return await getDb().transaction(async (tx) => {
      if (path === "/sign-up/email")
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${String(body.email)}, 71002))`,
        );
      if (path === "/verify-email") {
        const payload = await verifyJWT<{ email?: string; userId?: string; updateTo?: string }>(
          url.searchParams.get("token") ?? "",
          process.env.BETTER_AUTH_SECRET!,
        );
        if (!payload?.email || payload.updateTo)
          return fail("This verification link has expired or is invalid.", 400, "INVALID_TOKEN");
        const [account] = await tx
          .select()
          .from(user)
          .where(eq(user.email, payload.email))
          .for("update");
        if (!account || (payload.userId && payload.userId !== account.id))
          return fail("This verification link is invalid.", 400, "INVALID_TOKEN");
        if (account.emailVerified)
          return fail("This verification link has already been used.", 400, "ALREADY_USED");
      }
      const instance = betterAuth(makeAuthOptions(tx));
      let current =
        accountPaths.has(path) || isCode
          ? await instance.api.getSession({
              headers: request.headers,
              query: { disableRefresh: true },
            })
          : null;
      // Serialize password sign-in, reset and security changes for each user.
      // Re-read sessions/tokens after locking so a waiting request cannot act on
      // credentials revoked by the transaction ahead of it.
      if (path === "/sign-in/email") {
        await tx
          .select({ id: user.id })
          .from(user)
          .where(eq(user.email, String(body.email)))
          .for("update");
      } else {
        let userId = current?.user.id;
        if (!userId && (path === "/reset-password" || challenge)) {
          const identifier =
            path === "/reset-password" ? `reset-password:${body.token}` : challenge!;
          const [token] = await tx
            .select({ userId: verification.value })
            .from(verification)
            .where(eq(verification.identifier, identifier));
          userId = token?.userId;
        }
        if (userId) {
          await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("update");
          if (current)
            current = await instance.api.getSession({
              headers: request.headers,
              query: { disableRefresh: true },
            });
        }
      }
      if (accountPaths.has(path) && !current?.user.emailVerified)
        return fail("Sign in to continue.", 401);
      if (path === "/list-sessions")
        return Response.json(await listAccountSessions(tx, current!.user.id, current!.session.id), {
          headers: { "Cache-Control": "no-store" },
        });
      if (path === "/revoke-session") {
        if (!z.uuid().safeParse(body.sessionId).success) return fail("Invalid session.");
        await revokeAccountSession(
          tx,
          current!.user.id,
          current!.session.id,
          String(body.sessionId),
        );
        return Response.json({ status: true });
      }
      const response = await instance.handler(forwarded);
      // Better Auth returns error Responses; explicitly roll back any partial writes.
      if (response.status >= 400) {
        if (path === "/sign-in/email") {
          const error = await response
            .clone()
            .json()
            .catch(() => ({}));
          if (response.status < 500 && error.code !== "EMAIL_NOT_VERIFIED")
            throw new RollbackResponse(fail("Email or password is incorrect", 401));
        }
        throw new RollbackResponse(response);
      }
      // Do not expose synthetic versus persisted user fields on signup.
      if (path === "/sign-up/email") return Response.json({ status: true });
      if (path === "/request-password-reset")
        return Response.json({ status: true, message: "If an account exists, we sent a link" });
      if (path === "/change-password") await passwordChanged(tx, current!.user);
      if (path === "/get-session") {
        const data = await response.clone().json();
        if (data?.session?.id) await touchSession(data.session.id, tx);
      }
      if (path === "/two-factor/enable") {
        const data = await response.json();
        // Reveal codes only after the user proves their authenticator is configured.
        return Response.json({ totpURI: data.totpURI }, { headers: response.headers });
      }
      if (path === "/two-factor/verify-totp" && current && !current.user.twoFactorEnabled) {
        const codes = await instance.api.viewBackupCodes({ body: { userId: current.user.id } });
        return Response.json(
          { status: true, backupCodes: codes.backupCodes },
          { headers: response.headers },
        );
      }
      return response;
    });
  } catch (error) {
    if (error instanceof RollbackResponse) return error.response;
    if (error instanceof APIError) return fail(error.message, error.statusCode);
    throw error;
  }
}

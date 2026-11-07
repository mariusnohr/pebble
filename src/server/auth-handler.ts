import "server-only";
import { betterAuth } from "better-auth";
import { verifyJWT } from "better-auth/crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { user } from "@/db/schema";
import { makeAuthOptions } from "./auth-options";
import { appOrigin } from "./config";
import { clientAddress, rateLimit } from "./rate-limit";
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
]);
const getPaths = new Set(["/get-session", "/verify-email"]);
class RollbackResponse {
  constructor(readonly response: Response) {}
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
      const response = await betterAuth(makeAuthOptions(tx)).handler(forwarded);
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
      return response;
    });
  } catch (error) {
    if (error instanceof RollbackResponse) return error.response;
    throw error;
  }
}

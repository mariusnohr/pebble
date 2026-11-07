import { test } from "node:test";
import assert from "node:assert/strict";
import { signupAllowed } from "../src/server/signup-gate";
import { clientAddress } from "../src/server/rate-limit";
import { renderEmail } from "../src/server/email/templates";

test("the launch gate defaults closed and matches operator addresses case-insensitively", (t) => {
  const previous = {
    SIGNUP_OPEN: process.env.SIGNUP_OPEN,
    OPERATOR_EMAILS: process.env.OPERATOR_EMAILS,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.SIGNUP_OPEN = "false";
  process.env.OPERATOR_EMAILS = " One@example.com, TWO@example.com ";
  assert.equal(signupAllowed("visitor@example.com"), false);
  assert.equal(signupAllowed("one@EXAMPLE.com"), true);
  assert.equal(signupAllowed("two@example.com"), true);
  process.env.SIGNUP_OPEN = "true";
  assert.equal(signupAllowed("visitor@example.com"), true);
});
test("trusted proxy uses the final forwarded address, never the spoofable first address", (t) => {
  const previous = process.env.TRUST_PROXY;
  t.after(() => {
    if (previous === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previous;
  });
  process.env.TRUST_PROXY = "true";
  const headers = new Headers({ "x-forwarded-for": "spoofed, 203.0.113.8", "x-real-ip": "wrong" });
  assert.equal(clientAddress(headers), "203.0.113.8");
  assert.equal(clientAddress(new Headers()), "unknown");
  process.env.TRUST_PROXY = "false";
  assert.equal(clientAddress(headers), "direct");
});
test("signup-attempt mail contains no verification link", () => {
  const result = renderEmail(
    "signupAttempt",
    {
      subject: "Someone tried to sign up",
      heading: "Someone tried to sign up",
      paragraphs: ["Your account has not changed."],
      links: [],
    },
    "https://pebble.example",
  );
  assert.deepEqual(result.links, []);
  assert.doesNotMatch(result.text, /token=|verify-email/);
});

test("auth rejects duplicate cookies before parsing credentials or accessing the database", async () => {
  const { handleAuth } = await import("../src/server/auth-handler");
  for (const name of [
    "better-auth.two_factor",
    "__Secure-better-auth.two_factor",
    "better-auth.session_token",
  ]) {
    for (const cookie of [
      `${name}=first; ${name}=second`,
      `${name}=second; ${name}=first`,
      `${name}=first; unrelated=value;\t${name} =second`,
      `${name}="first"; ${name}="second"`,
    ]) {
      for (const path of ["two-factor/verify-totp", "two-factor/verify-backup-code"]) {
        const response = await handleAuth(
          new Request(`http://localhost:3000/api/auth/${path}`, {
            method: "POST",
            headers: { cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ code: "123456" }),
          }),
        );
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, "DUPLICATE_COOKIES");
        assert.deepEqual(response.headers.getSetCookie(), []);
      }
    }
  }
});

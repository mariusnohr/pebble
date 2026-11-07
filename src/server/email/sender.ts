import "server-only";
import type { PoolClient } from "pg";
import { MAX_ATTEMPTS, retryDelay } from "../jobs/retry";
import { renderEmail } from "./templates";

export const EMAIL_RETRY_WINDOW_MS = 60 * 60 * 1000;
const SEND_TIMEOUT_MS = 10_000;
const SEND_LEASE_MS = 60_000;

type EmailEnvironment = Record<string, string | undefined>;
export type SenderOptions = {
  env?: EmailEnvironment;
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (line: string) => void;
};
type OutboxRow = {
  id: string;
  to: string;
  template: string;
  payload: unknown;
  attempts: number;
  first_attempt_at: Date | null;
  failure_reason: string | null;
};

export function emailTransport(env: EmailEnvironment = process.env) {
  if (env.EMAIL_TRANSPORT === "log") return "log";
  if (env.RESEND_API_KEY) return "resend";
  return "not_configured";
}

export function warnIfEmailUnconfigured(
  env: EmailEnvironment = process.env,
  warn: (line: string) => void = console.warn,
) {
  if (emailTransport(env) === "not_configured") warn("Email is not configured");
}

// Run under the outbox job's per-kind lock. Persist the attempt BEFORE calling the provider:
// if the process dies after acceptance, the next process reuses this row's idempotency key.
export async function sendOutbox(db: PoolClient, options: SenderOptions = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? console.log;
  const started = Date.now();
  // Bound each run so a busy outbox yields back to the next tick.
  for (let count = 0; count < 25 && Date.now() - started < 20_000; count++) {
    const claimedAt = now();
    const { rows } = await db.query<OutboxRow>(
      `update email_outbox set next_attempt_at = $2
       where id = (
         select id from email_outbox where status = 'queued' and next_attempt_at <= $1
         order by next_attempt_at, id for update skip locked limit 1
       ) returning *`,
      [claimedAt, new Date(claimedAt.getTime() + SEND_LEASE_MS)],
    );
    const email = rows[0];
    if (!email) break;

    const fail = async (reason: string) => {
      await db.query(
        "update email_outbox set status = 'failed', failure_reason = $2 where id = $1",
        [email.id, reason],
      );
      // Never log a provider body, exception message, recipient or payload on failure.
      log(JSON.stringify({ template: email.template, reason }));
    };
    const firstAttempt = email.first_attempt_at ?? claimedAt;
    const deadline = firstAttempt.getTime() + EMAIL_RETRY_WINDOW_MS;
    if (claimedAt.getTime() >= deadline) {
      await fail("retry_window_expired");
      continue;
    }
    if (email.attempts >= MAX_ATTEMPTS) {
      await fail(email.failure_reason ?? "attempts_exhausted");
      continue;
    }

    email.attempts++;
    await db.query(
      `update email_outbox set attempts = $2, first_attempt_at = coalesce(first_attempt_at, $3)
       where id = $1`,
      [email.id, email.attempts, firstAttempt],
    );
    const transport = emailTransport(env);
    if (transport === "not_configured") {
      await fail("not_configured");
      continue;
    }
    if (transport === "resend" && !env.EMAIL_FROM) {
      await fail("missing_email_from");
      continue;
    }

    let rendered;
    try {
      rendered = renderEmail(email.template, email.payload, env.APP_URL ?? "");
    } catch {
      await fail("invalid_template_or_config");
      continue;
    }
    let providerId: string | null = null;
    let reason: string | undefined;
    let retryable = false;
    if (transport === "log") {
      log(JSON.stringify({ to: email.to, subject: rendered.subject, links: rendered.links }));
    } else {
      if (now().getTime() >= deadline) {
        await fail("retry_window_expired");
        continue;
      }
      const signal = AbortSignal.timeout(
        Math.max(1, Math.min(SEND_TIMEOUT_MS, deadline - now().getTime())),
      );
      try {
        const response = await (options.fetch ?? fetch)("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": email.id,
          },
          body: JSON.stringify({
            from: env.EMAIL_FROM,
            to: [email.to],
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
          }),
          signal,
        });
        if (response.ok) {
          const body: unknown = await response.json();
          if (body && typeof body === "object" && "id" in body && typeof body.id === "string") {
            providerId = body.id;
          } else {
            reason = "invalid_response";
            retryable = true;
          }
        } else {
          reason = `http_${response.status}`;
          retryable = response.status >= 500 || [408, 409, 429].includes(response.status);
          await response.body?.cancel();
        }
      } catch (error) {
        reason =
          signal.aborted || (error instanceof Error && error.name === "TimeoutError")
            ? "timeout"
            : "network_error";
        retryable = true;
      }
    }

    if (reason) {
      const retryAt = new Date(now().getTime() + retryDelay(email.attempts));
      if (!retryable || email.attempts >= MAX_ATTEMPTS || retryAt.getTime() >= deadline) {
        await fail(reason);
      } else {
        await db.query(
          "update email_outbox set failure_reason = $2, next_attempt_at = $3 where id = $1",
          [email.id, reason, retryAt],
        );
      }
    } else {
      await db.query(
        `update email_outbox set status = 'sent', sent_at = $2, provider_id = $3,
         failure_reason = null where id = $1`,
        [email.id, now(), providerId],
      );
    }
  }
}

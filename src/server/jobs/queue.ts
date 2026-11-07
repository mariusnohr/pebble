import "server-only";
import type { Pool, PoolClient } from "pg";
import { MAX_ATTEMPTS, retryDelay } from "./retry";

export const TICK_MS = 30_000;
export const JOB_LEASE_MS = 120_000;
const LOCK_NAMESPACE = 0x50454242;
const kindLocks = { retention: 1, purge: 2, outbox: 3, legacy_projects: 4 };
export type JobKind = keyof typeof kindLocks;
export const JOB_KINDS = Object.keys(kindLocks) as JobKind[];
export type Job = { id: string; kind: JobKind; attempts: number; payload: Record<string, unknown> };
export type JobHandler = (db: PoolClient, job: Job) => Promise<void>;

export function scheduledJobs(now: Date) {
  const schedules: { kind: JobKind; uniqueKey: string; runAt: Date }[] = [];
  for (const [kind, minute] of [
    ["retention", 0],
    ["purge", 30],
  ] as const) {
    const due = new Date(now);
    due.setUTCHours(3, minute, 0, 0);
    if (due > now) due.setUTCDate(due.getUTCDate() - 1);
    // Catch up the latest due day after downtime and persist the next run in advance.
    for (let day = 0; day < 2; day++) {
      const runAt = new Date(due.getTime() + day * 86_400_000);
      schedules.push({ kind, uniqueKey: `${kind}:${runAt.toISOString().slice(0, 10)}`, runAt });
    }
  }
  const runAt = new Date(Math.floor(now.getTime() / TICK_MS) * TICK_MS);
  for (const kind of ["outbox", "legacy_projects"] as const) {
    schedules.push({ kind, uniqueKey: `${kind}:${runAt.toISOString()}`, runAt });
  }
  return schedules;
}

export async function enqueueSchedules(db: Pool, now = new Date()) {
  for (const job of scheduledJobs(now)) {
    await db.query(
      "insert into jobs (kind, unique_key, run_at) values ($1, $2, $3) on conflict (unique_key) do nothing",
      [job.kind, job.uniqueKey, job.runAt],
    );
  }
}

// The transaction lock serializes claims of different rows of the SAME kind.
// SKIP LOCKED alone would only prevent two workers claiming the same row.
export async function claimJob(db: PoolClient, kind: JobKind, now = new Date()) {
  await db.query("begin");
  try {
    const lock = await db.query<{ acquired: boolean }>(
      "select pg_try_advisory_xact_lock($1, $2) as acquired",
      [LOCK_NAMESPACE, kindLocks[kind]],
    );
    if (!lock.rows[0].acquired) {
      await db.query("commit");
      return undefined;
    }
    // A crash on the last allowed attempt must not leave an immortal queued job.
    await db.query(
      `update jobs set finished_at = $2, locked_until = null,
       last_error = coalesce(last_error, 'attempts_exhausted')
       where kind = $1 and finished_at is null and attempts >= $3
       and (locked_until is null or locked_until <= $2)`,
      [kind, now, MAX_ATTEMPTS],
    );
    const { rows } = await db.query<Job>(
      `update jobs set locked_until = $3, attempts = attempts + 1
       where id = (
         select id from jobs where kind = $1 and finished_at is null and run_at <= $2
         and attempts < $4 and (locked_until is null or locked_until <= $2)
         and not exists (
           select 1 from jobs active where active.kind = $1
           and active.finished_at is null and active.locked_until > $2
         )
         order by run_at, id for update skip locked limit 1
       ) returning id, kind, attempts, payload`,
      [kind, now, new Date(now.getTime() + JOB_LEASE_MS), MAX_ATTEMPTS],
    );
    await db.query("commit");
    return rows[0] as Job | undefined;
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}

export async function runNextJob(
  pool: Pool,
  kind: JobKind,
  handler: JobHandler,
  options: { now?: () => Date; log?: (line: string) => void } = {},
) {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? console.log;
  const db = await pool.connect();
  let broken = false;
  const onError = () => {
    broken = true;
  };
  db.on("error", onError);
  let locked = false;
  try {
    // Hold a session lock while executing, even if a slow job outlives its lease.
    // Process/connection death releases this lock; the persisted lease then gates recovery.
    const lock = await db.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock($1, $2) as acquired",
      [LOCK_NAMESPACE, kindLocks[kind]],
    );
    locked = lock.rows[0].acquired;
    if (!locked) return false;
    const job = await claimJob(db, kind, now());
    if (!job) return false;
    const started = performance.now();
    let outcome = "interrupted";
    try {
      try {
        await handler(db, job);
      } catch {
        const exhausted = job.attempts >= MAX_ATTEMPTS;
        const failedAt = now();
        await db.query(
          `update jobs set locked_until = null, last_error = 'execution_failed', run_at = $3,
           finished_at = $4 where id = $1 and attempts = $2 and finished_at is null`,
          [
            job.id,
            job.attempts,
            new Date(failedAt.getTime() + retryDelay(job.attempts)),
            exhausted ? failedAt : null,
          ],
        );
        outcome = exhausted ? "failed" : "retry";
        return true;
      }
      const result = await db.query(
        `update jobs set finished_at = $3, locked_until = null, last_error = null
         where id = $1 and attempts = $2 and finished_at is null`,
        [job.id, job.attempts, now()],
      );
      outcome = result.rowCount ? "finished" : "superseded";
      return true;
    } finally {
      log(JSON.stringify({ kind, duration_ms: Math.round(performance.now() - started), outcome }));
    }
  } finally {
    if (locked && !broken) {
      try {
        await db.query("select pg_advisory_unlock($1, $2)", [LOCK_NAMESPACE, kindLocks[kind]]);
      } catch {
        broken = true;
      }
    }
    db.removeListener("error", onError);
    db.release(broken);
  }
}

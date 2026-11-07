import "server-only";
import type { Pool } from "pg";
import { getDb } from "../../db";
import { sendOutbox, warnIfEmailUnconfigured } from "../email/sender";
import { cleanupRetention, purgeMaintenance } from "./cleanup";
import {
  enqueueSchedules,
  JOB_KINDS,
  runNextJob,
  TICK_MS,
  type JobHandler,
  type JobKind,
} from "./queue";

const handlers: Record<JobKind, JobHandler> = {
  retention: cleanupRetention,
  purge: purgeMaintenance,
  outbox: (db) => sendOutbox(db),
};
const globalRunner = globalThis as unknown as { pebbleJobRunner?: ReturnType<typeof setInterval> };

export function startJobRunner(pool?: Pool) {
  if (globalRunner.pebbleJobRunner) return;
  const connection = pool ?? getDb().$client;
  const running = new Set<JobKind>();
  let scheduling = false;
  const reportFailure = () =>
    console.error(JSON.stringify({ event: "job_runner_error", reason: "database_unavailable" }));
  const tick = async () => {
    if (scheduling) return;
    scheduling = true;
    try {
      await enqueueSchedules(connection);
      for (const kind of JOB_KINDS) {
        if (running.has(kind)) continue;
        running.add(kind);
        // A long retention run must not delay the next outbox tick.
        void runNextJob(connection, kind, handlers[kind])
          .catch(reportFailure)
          .finally(() => running.delete(kind));
      }
    } catch {
      reportFailure();
    } finally {
      scheduling = false;
    }
  };
  globalRunner.pebbleJobRunner = setInterval(() => void tick(), TICK_MS);
  globalRunner.pebbleJobRunner.unref();
  warnIfEmailUnconfigured();
  console.log(JSON.stringify({ event: "job_runner_started", interval_ms: TICK_MS }));
  // Boot stays independent of database availability; the next tick retries connection failures.
  void tick();
}

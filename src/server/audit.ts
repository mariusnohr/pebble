import "server-only";
import { auditLog } from "@/db/schema";
import type { Transaction } from "./organizations";
export async function recordAudit(
  tx: Transaction,
  entry: {
    organizationId: string;
    actor: { id: string; name: string; email: string };
    action: string;
    targetType: "project" | "ingest_key";
    targetId: string;
    details?: Record<string, unknown>;
  },
) {
  const { actor, ...data } = entry;
  await tx
    .insert(auditLog)
    .values({ ...data, actorUserId: actor.id, actorLabel: `${actor.name} <${actor.email}>` });
}

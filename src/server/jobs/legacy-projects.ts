import "server-only";
import type { PoolClient } from "pg";
import { LEGACY_ORGANIZATION_ID } from "../legacy-organization";

export async function backfillLegacyProjects(db: PoolClient) {
  // Old releases omit organization_id during builds and after rollbacks.
  // The predicate makes repeats safe and preserves explicit tenant assignments.
  await db.query("update projects set organization_id = $1 where organization_id is null", [
    LEGACY_ORGANIZATION_ID,
  ]);
}

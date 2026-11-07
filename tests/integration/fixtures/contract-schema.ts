import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { assertTestDatabase } from "../../../scripts/rehearse-cutover";
import {
  M1_MIGRATION,
  migrateThrough,
  migrateWithConfirmation,
} from "../../../scripts/migration-boundary";
import { LEGACY_ORGANIZATION_ID } from "../../../src/server/legacy-organization";

// A disposable test database needs an explicit fixture claim before contraction.
// Never install this fixture in an application database or use it as deploy evidence.
export async function prepareContractDatabase(pool: Pool) {
  await assertTestDatabase(pool);
  await migrateThrough(pool, M1_MIGRATION);
  const { rows } = await pool.query("select to_regclass('public.admin_sessions') as legacy");
  if (!rows[0].legacy) {
    await migrateWithConfirmation(pool);
    return;
  }
  const owner = randomUUID();
  try {
    await pool.query(
      `insert into "user" (id, name, email, email_verified)
       values ($1, 'Contract fixture', $2, true)`,
      [owner, `contract-${owner}@example.com`],
    );
    await pool.query(
      `insert into member (organization_id, user_id, role, created_at)
       values ($1, $2, 'owner', now()) on conflict do nothing`,
      [LEGACY_ORGANIZATION_ID, owner],
    );
    await migrateWithConfirmation(pool, "Disposable integration fixture; not deployment evidence");
  } finally {
    await pool.query('delete from "user" where id = $1', [owner]);
  }
}

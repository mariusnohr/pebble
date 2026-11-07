-- F3 must be the first standalone M2 deployment. The owner records the production
-- M1 release, ownership claim and verification in Nohr before setting this reference.
-- Drizzle runs the guards, backfill, constraints, drop and journal write atomically.
DO $$
BEGIN
  IF nullif(btrim(current_setting('pebble.f3_contract_confirmation', true)), '') IS NULL THEN
    RAISE EXCEPTION 'F3 requires F3_CONTRACT_CONFIRMATION referencing the owner''s production M1 verification and ownership claim';
  END IF;

  -- Identity is stable even if the owner renamed Pebble or changed its slug.
  -- Keep FK KEY SHARE checks compatible while waiting for the projects lock:
  -- M1 project/audit inserts may already hold projects locks at this point.
  PERFORM 1 FROM "organization"
    WHERE "id" = '8d3b7c14-a8c9-4ae4-91e9-a9cf44232f1b' FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'F3 requires the legacy Pebble organization; restore or investigate before contracting';
  END IF;

  PERFORM 1 FROM "member" m JOIN "user" u ON u."id" = m."user_id"
    WHERE m."organization_id" = '8d3b7c14-a8c9-4ae4-91e9-a9cf44232f1b'
      AND m."role" = 'owner' AND u."email_verified" = true
    FOR SHARE OF m, u;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'F3 requires a verified owner to claim the legacy Pebble organization before contracting';
  END IF;
END $$;
--> statement-breakpoint
-- Serialize the final backfill with in-flight project inserts. M1 supplies an
-- organization ID on every new project; the pre-M1 release is no longer supported.
LOCK TABLE "projects" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
UPDATE "projects" SET "organization_id" = '8d3b7c14-a8c9-4ae4-91e9-a9cf44232f1b'
  WHERE "organization_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "organization_id" SET NOT NULL;
--> statement-breakpoint
DROP TABLE "admin_sessions";

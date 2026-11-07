ALTER TABLE "invitation" ADD COLUMN "resend_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "invitation" ADD COLUMN "accepted_at" timestamp with time zone;

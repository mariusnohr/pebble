CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"to" text NOT NULL,
	"template" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"failure_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"provider_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_attempt_at" timestamp with time zone,
	CONSTRAINT "email_outbox_status" CHECK ("email_outbox"."status" in ('queued', 'sent', 'failed')),
	CONSTRAINT "email_outbox_attempts_nonnegative" CHECK ("email_outbox"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"unique_key" text NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"locked_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"finished_at" timestamp with time zone,
	CONSTRAINT "jobs_unique_key_unique" UNIQUE("unique_key"),
	CONSTRAINT "jobs_attempts_nonnegative" CHECK ("jobs"."attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX "email_outbox_due" ON "email_outbox" USING btree ("next_attempt_at") WHERE "email_outbox"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "email_outbox_created" ON "email_outbox" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "jobs_due" ON "jobs" USING btree ("kind","run_at") WHERE "jobs"."finished_at" is null;--> statement-breakpoint
CREATE INDEX "jobs_finished" ON "jobs" USING btree ("finished_at");
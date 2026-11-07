import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  primaryKey,
  index,
  check,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth-schema";

export * from "./auth-schema";

const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    agentContext: text("agent_context").notNull().default(""),
    name: text("name").notNull(),
    origins: text("origins").array().notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    paused: boolean("paused").notNull().default(false),
    retentionDays: integer("retention_days").notNull().default(90),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("retention_range", sql`${t.retentionDays} between 7 and 730`),
    check("projects_agent_context_length", sql`char_length(${t.agentContext}) <= 4000`),
    index("projects_organization_id").on(t.organizationId),
  ],
);

export const visits = pgTable(
  "visits",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    id: uuid("id").notNull(),
    visitorId: uuid("visitor_id").notNull(),
    startedAt: time("started_at").notNull(),
    lastSeenAt: time("last_seen_at").notNull(),
    browserSeenAt: time("browser_seen_at"),
    entryPath: text("entry_path"),
    currentPath: text("current_path"),
    referrer: text("referrer"),
    browser: text("browser"),
    os: text("os"),
    device: text("device"),
    language: text("language"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.id] }),
    index("visits_project_time").on(t.projectId, t.startedAt),
    index("visits_presence").on(t.projectId, t.browserSeenAt),
  ],
);

export const events = pgTable(
  "events",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    id: uuid("id").notNull(),
    type: text("type", { enum: ["pageview", "event"] }).notNull(),
    source: text("source", { enum: ["browser", "server"] }).notNull(),
    occurredAt: time("occurred_at").notNull(),
    receivedAt: time("received_at").notNull().defaultNow(),
    visitorId: uuid("visitor_id"),
    visitId: uuid("visit_id"),
    path: text("path"),
    name: text("name"),
    properties: jsonb("properties")
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default({}),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.id] }),
    index("events_project_time").on(t.projectId, t.occurredAt),
    index("events_project_name").on(t.projectId, t.name, t.occurredAt),
  ],
);

export const apiKeys = pgTable("project_api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: time("created_at").notNull().defaultNow(),
  lastUsedAt: time("last_used_at"),
  revokedAt: time("revoked_at"),
});

export const adminSessions = pgTable("admin_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  passwordVersion: text("password_version").notNull(),
  expiresAt: time("expires_at").notNull(),
});

export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  expiresAt: time("expires_at").notNull(),
});

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    uniqueKey: text("unique_key").notNull().unique(),
    runAt: time("run_at").notNull(),
    lockedUntil: time("locked_until"),
    attempts: integer("attempts").notNull().default(0),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    lastError: text("last_error"),
    finishedAt: time("finished_at"),
  },
  (t) => [
    index("jobs_due")
      .on(t.kind, t.runAt)
      .where(sql`${t.finishedAt} is null`),
    index("jobs_finished").on(t.finishedAt),
    check("jobs_attempts_nonnegative", sql`${t.attempts} >= 0`),
  ],
);

export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    to: text("to").notNull(),
    template: text("template").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status", { enum: ["queued", "sent", "failed"] })
      .notNull()
      .default("queued"),
    failureReason: text("failure_reason"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: time("next_attempt_at").notNull().defaultNow(),
    sentAt: time("sent_at"),
    providerId: text("provider_id"),
    // Durable clocks for purging every status and bounding retries across restarts.
    createdAt: time("created_at").notNull().defaultNow(),
    firstAttemptAt: time("first_attempt_at"),
  },
  (t) => [
    index("email_outbox_due")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'queued'`),
    index("email_outbox_created").on(t.createdAt),
    check("email_outbox_status", sql`${t.status} in ('queued', 'sent', 'failed')`),
    check("email_outbox_attempts_nonnegative", sql`${t.attempts} >= 0`),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    actorLabel: text("actor_label").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_organization_time").on(t.organizationId, t.createdAt, t.id),
    index("audit_log_created").on(t.createdAt),
  ],
);

export const usagePeriods = pgTable(
  "usage_periods",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    period: text("period").notNull(),
    events: bigint("events", { mode: "number" }).notNull().default(0),
    droppedEvents: bigint("dropped_events", { mode: "number" }).notNull().default(0),
    aiCredits: bigint("ai_credits", { mode: "number" }).notNull().default(0),
    warned80At: time("warned80_at"),
    warned100At: time("warned100_at"),
    stoppedAt: time("stopped_at"),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.period] }),
    check("usage_periods_month", sql`${t.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check(
      "usage_periods_nonnegative",
      sql`${t.events} >= 0 and ${t.droppedEvents} >= 0 and ${t.aiCredits} >= 0`,
    ),
  ],
);

export type Project = typeof projects.$inferSelect;

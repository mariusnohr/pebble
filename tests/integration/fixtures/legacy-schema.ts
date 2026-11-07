// Frozen copy of src/db/schema.ts at abb7927a. Do not update with the app schema:
// these table definitions exercise the pre-M1 release against future migrations.
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  primaryKey,
  index,
  check,
} from "drizzle-orm/pg-core";

const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    origins: text("origins").array().notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    paused: boolean("paused").notNull().default(false),
    retentionDays: integer("retention_days").notNull().default(90),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [check("retention_range", sql`${t.retentionDays} between 7 and 730`)],
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

export type Project = typeof projects.$inferSelect;

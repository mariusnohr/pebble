// Frozen M1 project shape: keep rollback compatibility independent of current schema types.
import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id"),
  agentContext: text("agent_context").notNull().default(""),
  name: text("name").notNull(),
  origins: text("origins").array().notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  paused: boolean("paused").notNull().default(false),
  retentionDays: integer("retention_days").notNull().default(90),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

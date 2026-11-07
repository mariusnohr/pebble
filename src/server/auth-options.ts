import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { organization, twoFactor } from "better-auth/plugins";
import { defaultRoles } from "better-auth/plugins/organization/access";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema";

// Schema-generation configuration only during the expand step. No route imports
// this module; admin-password authentication remains in src/server/auth.ts.
// Constructing Drizzle's pool does not connect, so the CLI works offline.
export const authOptions = {
  database: drizzleAdapter(
    drizzle({
      connection: {
        connectionString: process.env.DATABASE_URL,
        max: 10,
        connectionTimeoutMillis: 5000,
        statement_timeout: 15000,
      },
      schema,
    }),
    { provider: "pg", schema, transaction: true },
  ),
  baseURL: process.env.APP_URL,
  trustedOrigins: process.env.APP_URL ? [process.env.APP_URL] : [],
  advanced: { database: { generateId: "uuid" } },
  emailAndPassword: { enabled: true },
  session: { expiresIn: 14 * 86400, updateAge: 86400 },
  rateLimit: { enabled: true, storage: "database" },
  user: {
    additionalFields: {
      lastOrganizationId: {
        type: "string",
        required: false,
        input: false,
        references: { model: "organization", field: "id", onDelete: "set null" },
      },
    },
  },
  plugins: [
    organization({
      roles: defaultRoles,
      invitationExpiresIn: 7 * 86400,
      schema: {
        organization: {
          additionalFields: {
            aiEnabled: { type: "boolean", required: true, defaultValue: true, input: false },
            stripeCustomerId: { type: "string", required: false, input: false },
            planOverride: { type: ["pro", "business"], required: false, input: false },
            planOverrideNote: { type: "string", required: false, input: false },
            suspendedAt: { type: "date", required: false, input: false },
            suspendReason: { type: "string", required: false, input: false },
            retentionGraceUntil: { type: "date", required: false, input: false },
          },
        },
        invitation: {
          additionalFields: {
            resendCount: { type: "number", required: true, defaultValue: 0, input: false },
          },
        },
      },
    }),
    twoFactor(),
  ],
} satisfies BetterAuthOptions;

// The CLI discovers this named export. Mounting auth.handler is a later task.
export const auth = betterAuth(authOptions);

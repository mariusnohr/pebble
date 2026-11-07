import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { organization, twoFactor } from "better-auth/plugins";
import { defaultRoles } from "better-auth/plugins/organization/access";
import { drizzle } from "drizzle-orm/node-postgres";
import { queueEmail } from "./email/queue";
import { claimLegacyOrganization, type Transaction } from "./organizations";
import * as schema from "../db/schema";
import { deleteAccountOrganizations, passwordChanged } from "./account-security";

// The route supplies a transaction so account changes, the legacy claim and mail
// commit together. The standalone instance is also used by the schema CLI/session reads.
const database = drizzle({
  connection: {
    connectionString: process.env.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  },
  schema,
});
export function makeAuthOptions(tx?: Transaction) {
  const db = tx ?? database;
  return {
    appName: "Pebble",
    database: drizzleAdapter(db, { provider: "pg", schema, transaction: !tx }),
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.APP_URL,
    trustedOrigins: process.env.APP_URL ? [process.env.APP_URL] : [],
    advanced: {
      database: { generateId: "uuid" },
      useSecureCookies: process.env.APP_URL?.startsWith("https:") ?? false,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
      ipAddress: { disableIpTracking: true },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      requireEmailVerification: true,
      resetPasswordTokenExpiresIn: 3600,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }) => {
        const send = (connection: Transaction) =>
          queueEmail(connection, {
            to: user.email,
            template: "passwordReset",
            data: {
              subject: "Reset your Pebble password",
              heading: "Reset your password",
              paragraphs: [
                "Use this single-use link to reset your password. It expires in 1 hour. If you did not request this, you can ignore this email.",
              ],
              links: [
                {
                  label: "Reset password",
                  path: `/reset-password?token=${encodeURIComponent(token)}`,
                },
              ],
            },
          });
        if (tx) await send(tx);
        else await database.transaction(send);
      },
      onPasswordReset: async ({ user }) => {
        if (!tx) throw new Error("Password reset requires the auth route transaction.");
        await passwordChanged(tx, user);
      },
      onExistingUserSignUp: async ({ user }) => {
        const send = (connection: Transaction) =>
          queueEmail(connection, {
            to: user.email,
            template: "signupAttempt",
            data: {
              subject: "Someone tried to sign up for Pebble",
              heading: "Someone tried to sign up",
              paragraphs: [
                "Someone used your email address to sign up for Pebble. Your account has not changed. If this was not you, you can ignore this email.",
              ],
              links: [],
            },
          });
        if (tx) await send(tx);
        else await database.transaction(send);
      },
    },
    emailVerification: {
      expiresIn: 86400,
      sendOnSignUp: true,
      sendOnSignIn: false,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, token }) => {
        const send = (connection: Transaction) =>
          queueEmail(connection, {
            to: user.email,
            template: "verifyEmail",
            data: {
              subject: "Verify your Pebble email",
              heading: "Verify your email",
              paragraphs: [
                "Confirm your email address to start using Pebble. This link expires in 24 hours.",
              ],
              links: [
                { label: "Verify email", path: `/verify-email?token=${encodeURIComponent(token)}` },
              ],
            },
          });
        if (tx) await send(tx);
        else await database.transaction(send);
      },
      afterEmailVerification: async (user) => {
        if (!tx) throw new Error("Verification requires the auth route transaction.");
        await claimLegacyOrganization(tx, user);
      },
    },
    session: {
      expiresIn: 14 * 86400,
      updateAge: 86400,
      cookieCache: { enabled: false },
      additionalFields: { lastActiveAt: { type: "date", required: false, input: false } },
    },
    // Pebble limits requests using the last trusted X-Forwarded-For entry.
    rateLimit: { enabled: false },
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          if (!tx) throw new Error("Account deletion requires the auth route transaction.");
          await deleteAccountOrganizations(tx, user.id);
        },
      },
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
      twoFactor({
        issuer: "Pebble",
        backupCodeOptions: { amount: 10, storeBackupCodes: "encrypted" },
        // Pebble persists the required per-session budget outside the auth transaction.
        accountLockout: { enabled: false },
      }),
    ],
  } satisfies BetterAuthOptions;
}

export const authOptions = makeAuthOptions();
// The CLI discovers this named export.
export const auth = betterAuth(authOptions);

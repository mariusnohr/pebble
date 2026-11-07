import { and, eq, gt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { invitation } from "@/db/schema";

export function isOperator(email: string) {
  return (process.env.OPERATOR_EMAILS ?? "")
    .split(",")
    .some((entry) => entry.trim().toLowerCase() === email.trim().toLowerCase());
}

// The lookup is injected so this policy stays usable without a database at module load.
export async function signupAllowed(
  email: string,
  hasPendingInvitation: (email: string) => Promise<boolean> = async (address) => {
    const [invite] = await getDb()
      .select({ id: invitation.id })
      .from(invitation)
      .where(
        and(
          sql`lower(${invitation.email}) = ${address.trim().toLowerCase()}`,
          eq(invitation.status, "pending"),
          gt(invitation.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return Boolean(invite);
  },
) {
  return (
    process.env.SIGNUP_OPEN === "true" || isOperator(email) || (await hasPendingInvitation(email))
  );
}

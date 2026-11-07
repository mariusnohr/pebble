import "server-only";
import { z } from "zod";
import type { getDb } from "../../db";
import { emailOutbox } from "../../db/schema";
import { parseEmailData, type EmailData, type EmailTemplate } from "./templates";

type Transaction = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

export async function queueEmail<T extends EmailTemplate>(
  tx: Transaction,
  email: { to: string; template: T; data: EmailData<T> },
) {
  const [row] = await tx
    .insert(emailOutbox)
    .values({
      to: z.email().parse(email.to),
      template: email.template,
      payload: parseEmailData(email.template, email.data),
    })
    .returning({ id: emailOutbox.id });
  return row.id;
}

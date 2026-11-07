"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { assertSameOrigin, requireMemberUser, requireUser } from "./auth";
import {
  changeMembership,
  inviteMember,
  manageInvitation,
  MembershipError,
  respondToInvitation,
  transferOwnership,
} from "./members";

type State = { error?: string; success?: string };
export async function memberAction(_: State, form: FormData): Promise<State> {
  await assertSameOrigin();
  const actor = await requireMemberUser();
  const org = String(form.get("org") ?? "");
  const id = String(form.get("id") ?? "");
  const operation = form.get("operation");
  let departed = false;
  let success: string;
  try {
    switch (operation) {
      case "invite":
        await inviteMember(actor, org, form.get("email"), form.get("role"));
        success = "Invitation sent.";
        break;
      case "resend":
      case "revoke":
        await manageInvitation(actor, org, id, operation);
        success = operation === "resend" ? "Invitation resent." : "Invitation revoked.";
        break;
      case "role":
      case "remove":
      case "leave": {
        const result = await changeMembership(actor, org, id, operation, form.get("role"));
        departed = result?.departed ?? false;
        success = operation === "role" ? "Role updated." : "Member removed.";
        break;
      }
      case "transfer":
        await transferOwnership(actor, org, id, form.get("password"));
        success = "Ownership transferred. You are now an admin.";
        break;
      default:
        return { error: "Invalid membership action." };
    }
  } catch (error) {
    if (error instanceof MembershipError) return { error: error.message };
    throw error;
  }
  revalidatePath("/app", "layout");
  if (departed) redirect("/app");
  return { success };
}

export async function invitationResponseAction(_: State, form: FormData): Promise<State> {
  await assertSameOrigin();
  const actor = await requireUser();
  const id = String(form.get("id") ?? "");
  const response = form.get("response");
  if (response !== "accept" && response !== "decline")
    return { error: "Choose Accept or Decline." };
  let slug: string;
  try {
    slug = await respondToInvitation(actor, id, response === "accept");
  } catch (error) {
    if (error instanceof MembershipError) return { error: error.message };
    throw error;
  }
  revalidatePath("/app", "layout");
  revalidatePath(`/invite/${id}`);
  redirect(response === "accept" ? `/app/${slug}` : "/app");
}

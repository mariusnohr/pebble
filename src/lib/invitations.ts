export function invitationUnavailable(invite: { status: string; expiresAt: Date } | null) {
  if (!invite) return "This invitation is no longer available";
  if (invite.status === "accepted") return "This invitation has already been used";
  if (invite.status === "revoked" || invite.status === "canceled")
    return "This invitation has been revoked";
  if (invite.status === "rejected") return "This invitation has been declined";
  if (invite.status === "expired" || invite.expiresAt <= new Date())
    return "This invitation has expired";
  if (invite.status !== "pending") return "This invitation is no longer available";
  return null;
}

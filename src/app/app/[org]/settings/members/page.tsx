import { requireMemberUser } from "@/server/auth";
import { listMembers } from "@/server/members";
import { InviteForm, MemberButton, RoleForm } from "./forms";

export default async function MembersPage({ params }: { params: Promise<{ org: string }> }) {
  const actor = await requireMemberUser();
  const { org } = await params;
  const { role, members, invitations } = await listMembers(org, actor);
  const canManage = role === "owner" || role === "admin";
  const own = members.find((row) => row.userId === actor.id)!;
  return (
    <div className="max-w-4xl space-y-6">
      <section className="panel settings-panel">
        <div className="panel-heading">
          <h2>Members</h2>
        </div>
        <div className="overflow-x-auto px-6 pb-6">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className="p-3">Name</th>
                <th className="p-3">Email</th>
                <th className="p-3">Role</th>
                <th className="p-3">Joined</th>
                {canManage && <th className="p-3">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {members.map((person) => (
                <tr key={person.id} className="border-t align-top">
                  <td className="p-3">
                    {person.name}
                    {person.userId === actor.id && " (you)"}
                  </td>
                  <td className="p-3">{person.email}</td>
                  <td className="p-3 capitalize">{person.role}</td>
                  <td className="p-3 whitespace-nowrap">
                    {person.joined.toISOString().slice(0, 10)}
                  </td>
                  {canManage && (
                    <td className="p-3">
                      {person.role !== "owner" && (
                        <div className="space-y-3">
                          <RoleForm
                            key={person.role}
                            org={org}
                            id={person.id}
                            role={person.role}
                            name={person.name}
                          />
                          <MemberButton
                            org={org}
                            id={person.id}
                            operation="remove"
                            label="Remove member"
                            confirmation={`${person.name} will immediately lose access to this organization.`}
                          />
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel settings-panel">
        <div className="panel-heading">
          <h2>Pending invitations</h2>
        </div>
        <div className="px-6 pb-6">
          {!invitations.length ? (
            <p className="text-sm text-muted-foreground">No pending invitations.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th className="p-3">Email</th>
                    <th className="p-3">Role</th>
                    <th className="p-3">Expires (UTC)</th>
                    {canManage && <th className="p-3">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((invite) => (
                    <tr key={invite.id} className="border-t">
                      <td className="p-3">{invite.email}</td>
                      <td className="p-3 capitalize">{invite.role}</td>
                      <td className="p-3">
                        {invite.expiresAt.toISOString().replace("T", " ").slice(0, 16)}
                      </td>
                      {canManage && (
                        <td className="p-3">
                          <div className="flex flex-wrap gap-3">
                            <MemberButton
                              org={org}
                              id={invite.id}
                              operation="resend"
                              label="Resend"
                            />
                            <MemberButton
                              org={org}
                              id={invite.id}
                              operation="revoke"
                              label="Revoke invitation"
                              confirmation={`The invitation for ${invite.email} will no longer work.`}
                            />
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
      {canManage && (
        <section className="panel p-6 max-w-lg">
          <h2 className="mb-5 text-sm font-medium">Invite a colleague</h2>
          <InviteForm org={org} />
        </section>
      )}
      {role !== "owner" && (
        <section className="panel p-6">
          <h2 className="mb-4 text-sm font-medium">Leave organization</h2>
          <MemberButton
            org={org}
            id={own.id}
            operation="leave"
            label="Leave organization"
            confirmation="You will immediately lose access. An owner or admin will need to invite you again to rejoin."
          />
        </section>
      )}
    </div>
  );
}

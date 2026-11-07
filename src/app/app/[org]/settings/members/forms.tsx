"use client";

import { useActionState, useId } from "react";
import { memberAction } from "@/server/member-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

function Feedback({ state }: { state: { error?: string; success?: string } }) {
  return (
    <>
      {state.error && (
        <p role="alert" className="form-error">
          {state.error}
        </p>
      )}
      {state.success && (
        <p role="status" className="text-sm text-primary">
          {state.success}
        </p>
      )}
    </>
  );
}
function RoleSelect({ value = "member" }: { value?: string }) {
  const id = useId();
  return (
    <div className="field">
      <Label htmlFor={id}>Role</Label>
      <select id={id} name="role" defaultValue={value} className="text-input">
        <option value="member">Member</option>
        <option value="admin">Admin</option>
      </select>
    </div>
  );
}

export function InviteForm({ org }: { org: string }) {
  const [state, action, pending] = useActionState(memberAction, {});
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="operation" value="invite" />
      <div className="field">
        <Label htmlFor="invite-email">Email address</Label>
        <Input id="invite-email" type="email" name="email" required autoComplete="email" />
      </div>
      <RoleSelect />
      <p className="field-hint">
        Invitations expire in 7 days. Admins can manage projects and members.
      </p>
      <Feedback state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Sending…" : "Send invitation"}
      </Button>
    </form>
  );
}

export function RoleForm({
  org,
  id,
  role,
  name,
}: {
  org: string;
  id: string;
  role: string;
  name: string;
}) {
  const [state, action, pending] = useActionState(memberAction, {});
  return (
    <form action={action} aria-label={`Change role for ${name}`} className="space-y-3">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="operation" value="role" />
      <RoleSelect value={role} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        Save role
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function MemberButton({
  org,
  id,
  operation,
  label,
  confirmation,
}: {
  org: string;
  id: string;
  operation: "remove" | "leave" | "revoke" | "resend";
  label: string;
  confirmation?: string;
}) {
  const [state, action, pending] = useActionState(memberAction, {});
  const form = (
    <form action={action} className="space-y-3">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="operation" value={operation} />
      <Button
        type="submit"
        variant={confirmation ? "destructive" : "outline"}
        size="sm"
        disabled={pending}
      >
        {pending ? "Working…" : label}
      </Button>
      <Feedback state={state} />
    </form>
  );
  if (!confirmation) return form;
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>{label}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label}?</DialogTitle>
          <DialogDescription>{confirmation}</DialogDescription>
        </DialogHeader>
        {form}
      </DialogContent>
    </Dialog>
  );
}

export function TransferForm({
  org,
  admins,
}: {
  org: string;
  admins: { id: string; name: string; email: string }[];
}) {
  const [state, action, pending] = useActionState(memberAction, {});
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="operation" value="transfer" />
      <p className="text-sm text-muted-foreground">
        The selected admin becomes owner and you become an admin. Both of you will receive an email.
      </p>
      {!admins.length ? (
        <p className="text-sm">Promote a member to admin on the Members tab first.</p>
      ) : (
        <>
          <div className="field">
            <Label htmlFor="new-owner">New owner</Label>
            <select className="text-input" id="new-owner" name="id" required defaultValue="">
              <option value="" disabled>
                Choose an admin
              </option>
              {admins.map((admin) => (
                <option key={admin.id} value={admin.id}>
                  {admin.name} ({admin.email})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <Label htmlFor="transfer-password">Your password</Label>
            <Input
              type="password"
              id="transfer-password"
              name="password"
              required
              maxLength={128}
              autoComplete="current-password"
            />
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? "Transferring…" : "Transfer ownership"}
          </Button>
        </>
      )}
      <Feedback state={state} />
    </form>
  );
}

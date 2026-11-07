"use client";
import { useActionState } from "react";
import { invitationResponseAction } from "@/server/member-actions";
import { Button } from "@/components/ui/button";
export function RespondForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState(invitationResponseAction, {});
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="id" value={id} />
      <div className="flex gap-3">
        <Button name="response" value="accept" type="submit" disabled={pending}>
          Accept
        </Button>
        <Button name="response" value="decline" type="submit" variant="outline" disabled={pending}>
          Decline
        </Button>
      </div>
      {state.error && (
        <p role="alert" className="form-error">
          {state.error}
        </p>
      )}
    </form>
  );
}

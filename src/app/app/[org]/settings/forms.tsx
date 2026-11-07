"use client";

import { useActionState } from "react";
import { updateOrganizationAction, deleteOrganizationAction } from "@/server/actions";
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

type OrganizationDetails = { name: string; slug: string };

export function GeneralForm({ organization }: { organization: OrganizationDetails }) {
  const [state, action, pending] = useActionState(updateOrganizationAction, {});
  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="org" value={organization.slug} />
      <div className="field">
        <Label htmlFor="organization-name">Organization name</Label>
        <Input
          id="organization-name"
          name="name"
          defaultValue={organization.name}
          required
          minLength={1}
          maxLength={60}
        />
      </div>
      <div className="field">
        <Label htmlFor="organization-slug">URL slug</Label>
        <Input
          id="organization-slug"
          name="slug"
          defaultValue={organization.slug}
          required
          minLength={3}
          maxLength={40}
          pattern="[a-z0-9\-]+"
          autoCapitalize="none"
          spellCheck={false}
          aria-describedby="slug-hint"
        />
        <p id="slug-hint" className="field-hint">
          3–40 lowercase letters, numbers or hyphens. Changing this updates your organization URL;
          old links will stop working.
        </p>
      </div>
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
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save changes"}
      </Button>
    </form>
  );
}

export function DeleteOrganization({ organization }: { organization: OrganizationDetails }) {
  const [state, action, pending] = useActionState(deleteOrganizationAction, {});
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="destructive" />}>Delete organization</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {organization.name}?</DialogTitle>
          <DialogDescription>
            This permanently deletes the organization and everything in it. Type its exact name to
            confirm. Backups may retain data for up to 7 days.
          </DialogDescription>
        </DialogHeader>
        <form action={action} className="space-y-4">
          <input type="hidden" name="org" value={organization.slug} />
          <Label htmlFor="organization-confirmation">Organization name</Label>
          <Input
            id="organization-confirmation"
            name="confirmation"
            placeholder={organization.name}
            required
            autoComplete="off"
          />
          {state.error && (
            <p role="alert" className="form-error">
              {state.error}
            </p>
          )}
          <Button type="submit" variant="destructive" disabled={pending}>
            {pending ? "Deleting…" : "Permanently delete"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

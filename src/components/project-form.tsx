"use client";
import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, ArrowRight } from "lucide-react";
import { saveProjectAction, deleteProjectAction } from "@/server/actions";
import type { Project } from "@/db/schema";
import { normalizeLineEndings } from "@/lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";

export function ProjectForm({
  project,
  org,
  readOnly = false,
  onCreated,
}: {
  project?: Project;
  org: string;
  readOnly?: boolean;
  onCreated?: (id: string) => void;
}) {
  const [state, action, pending] = useActionState(saveProjectAction, {});
  const [agentContext, setAgentContext] = useState(() =>
    normalizeLineEndings(project?.agentContext ?? ""),
  );
  const contextLength = Array.from(agentContext).length;
  const contextTooLong = contextLength > 4000;
  useEffect(() => {
    if (!project && state.projectId) onCreated?.(state.projectId);
  }, [state.projectId, project, onCreated]);
  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="org" value={org} />
      <fieldset disabled={readOnly} className="space-y-5">
        {project && <input type="hidden" name="id" value={project.id} />}
        <div className="field">
          <Label htmlFor="project-name">Project name</Label>
          <Input
            id="project-name"
            name="name"
            defaultValue={project?.name}
            placeholder="My corner of the internet"
            required
            maxLength={60}
          />
        </div>
        <div className="field">
          <Label htmlFor="project-origins">Website origins</Label>
          <textarea
            id="project-origins"
            name="origins"
            defaultValue={project?.origins.join("\n")}
            placeholder="https://example.com"
            required
            rows={2}
            className="text-input resize-y"
          />
          <p className="field-hint">One origin per line. Add www and preview domains separately.</p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="field">
            <Label htmlFor="project-timezone">Reporting timezone</Label>
            <Input
              id="project-timezone"
              name="timezone"
              defaultValue={project?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}
              placeholder="Europe/Oslo"
              required
            />
          </div>
          <div className="field">
            <Label htmlFor="project-retention">Keep data for</Label>
            <div className="relative">
              <Input
                id="project-retention"
                name="retentionDays"
                type="number"
                min={7}
                max={730}
                defaultValue={project?.retentionDays ?? 90}
                required
                className="pr-14"
              />
              <span className="pointer-events-none absolute right-3 top-2 text-xs text-muted-foreground">
                days
              </span>
            </div>
          </div>
        </div>
        {project && (
          <div className="field">
            <Label htmlFor="project-agent-context">Agent context</Label>
            <textarea
              id="project-agent-context"
              name="agentContext"
              value={agentContext}
              onChange={(event) => setAgentContext(normalizeLineEndings(event.target.value))}
              rows={4}
              className="text-input resize-y"
              aria-invalid={contextTooLong}
              aria-describedby="agent-context-example agent-context-count agent-context-error"
            />
            <p id="agent-context-example" className="field-hint">
              Example: signup_completed fires when a trial starts; /pricing is our main funnel
              entry.
            </p>
            <p id="agent-context-count" className="field-hint">
              {contextLength.toLocaleString("en")} / 4,000 characters
            </p>
            <p
              id="agent-context-error"
              role={contextTooLong ? "alert" : undefined}
              className="form-error"
            >
              {contextTooLong ? "Agent context must be at most 4,000 characters." : ""}
            </p>
          </div>
        )}
        {project && (
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="paused"
              defaultChecked={project.paused}
              className="accent-primary"
            />
            Pause incoming tracking
          </label>
        )}
        {state.error && (
          <p role="alert" className="form-error">
            {state.error}
          </p>
        )}
        {project && state.success && (
          <p role="status" className="text-sm text-primary">
            {state.success}
          </p>
        )}
        <Button type="submit" disabled={pending || contextTooLong} className="h-10 px-4">
          {pending ? "Saving…" : project ? "Save changes" : "Create project"}
          <ArrowRight size={14} />
        </Button>
      </fieldset>
    </form>
  );
}

export function ProjectDialog({ org, compact = false }: { org: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant={compact ? "ghost" : "default"}
            size={compact ? "icon-sm" : "lg"}
            className={compact ? "" : "h-10 px-4"}
            aria-label="Add project"
          />
        }
      >
        <Plus size={15} />
        {!compact && "Add project"}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg p-7">
        <DialogHeader className="mb-3">
          <DialogTitle className="text-xl">A new little corner.</DialogTitle>
          <DialogDescription>Add a website to start understanding its visitors.</DialogDescription>
        </DialogHeader>
        <ProjectForm
          org={org}
          onCreated={(id) => {
            setOpen(false);
            router.push(`/app/${org}/projects/${id}/settings#connect`);
            router.refresh();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

export function DeleteProject({ project, org }: { project: Project; org: string }) {
  const [state, action, pending] = useActionState(deleteProjectAction, {});
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="destructive" />}>Delete project</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {project.name}?</DialogTitle>
          <DialogDescription>
            This permanently removes the project, its events, visits, and API keys. Type the project
            name to confirm.
          </DialogDescription>
        </DialogHeader>
        <form action={action} className="space-y-4">
          <input type="hidden" name="org" value={org} />
          <input type="hidden" name="id" value={project.id} />
          <Label htmlFor="confirm-delete">Project name</Label>
          <Input
            id="confirm-delete"
            name="confirmation"
            required
            autoComplete="off"
            placeholder={project.name}
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

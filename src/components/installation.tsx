"use client";
import { useActionState, useState } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import { createKeyAction, revokeKeyAction } from "@/server/actions";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "./ui/dialog";

export function CopyButton({ text }: { text: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setStatus("copied");
        } catch {
          setStatus("failed");
        }
        setTimeout(() => setStatus("idle"), 2500);
      }}
      aria-label="Copy to clipboard"
    >
      {status === "copied" ? <Check size={13} /> : <Copy size={13} />}
      {status === "copied" ? "Copied" : status === "failed" ? "Select and copy" : "Copy"}
    </Button>
  );
}

export function Installation({ projectId, endpoint }: { projectId: string; endpoint: string }) {
  const [tab, setTab] = useState<"browser" | "server">("browser");
  const snippet = `<script>\n  window.pebble = window.pebble || { q: [] };\n  window.pebble.track = function (...args) {\n    window.pebble.q.push(["track", ...args]);\n  };\n</script>\n<script defer\n  src="${endpoint}/tracker.v1.js"\n  data-project="${projectId}">\n</script>`;
  const server = `import { createClient } from "@pebble/analytics/server";\n\nconst pebble = createClient({\n  endpoint: "${endpoint}",\n  apiKey: process.env.PEBBLE_API_KEY,\n});\n\n// After your operation succeeds:\nconst result = await pebble.track("signup_completed", {\n  source: "newsletter",\n});`;
  const code = tab === "browser" ? snippet : server;
  return (
    <section className="panel settings-panel">
      <div className="panel-heading">
        <div>
          <h2>Connect your website</h2>
          <p>A small addition. A whole new perspective.</p>
        </div>
      </div>
      <div className="px-6 pb-6">
        <div className="mb-4 flex gap-2" role="group" aria-label="Tracking installation">
          <Button
            variant={tab === "browser" ? "secondary" : "ghost"}
            onClick={() => setTab("browser")}
          >
            Browser
          </Button>
          <Button
            variant={tab === "server" ? "secondary" : "ghost"}
            onClick={() => setTab("server")}
          >
            Node.js
          </Button>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          {tab === "browser"
            ? "Add this once to your website’s layout. Pageviews and live activity are tracked automatically."
            : "Install the SDK from this repository’s package archive, then create a server API key below. See the README for package installation."}
        </p>
        <div className="code-block">
          <div className="code-toolbar">
            <span>{tab === "browser" ? "Website layout" : "Server module"}</span>
            <CopyButton text={code} />
          </div>
          <pre>
            <code>{code}</code>
          </pre>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          {tab === "browser"
            ? 'Tracks paths without query strings. Add data-consent="required" to defer collection until you enable it. The SDK also supports direct TypeScript integration.'
            : "Keep this key in your server environment. Pass browser tracking context to connect server outcomes with their visits."}
        </p>
      </div>
    </section>
  );
}

type Key = {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};
export function ApiKeys({
  projectId,
  keys,
  org,
  readOnly = false,
}: {
  projectId: string;
  keys: Key[];
  org: string;
  readOnly?: boolean;
}) {
  const [state, action, pending] = useActionState(createKeyAction, {});
  return (
    <section className="panel settings-panel">
      <div className="panel-heading">
        <div>
          <h2>Server API keys</h2>
          <p>Write-only access, scoped to this project.</p>
        </div>
        <KeyRound size={17} className="text-muted-foreground" />
      </div>
      <div className="px-6 pb-6">
        {keys.filter((k) => !k.revokedAt).length > 0 && (
          <div className="mb-6 divide-y">
            {keys
              .filter((k) => !k.revokedAt)
              .map((key) => (
                <div key={key.id} className="flex items-center justify-between gap-3 py-4">
                  <div>
                    <div className="mb-1 text-sm font-medium">{key.name}</div>
                    <code className="text-xs text-muted-foreground">{key.prefix}…</code>
                  </div>
                  {!readOnly && (
                    <Dialog>
                      <DialogTrigger
                        render={
                          <Button variant="ghost" size="sm" className="text-muted-foreground" />
                        }
                      >
                        Revoke
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Revoke {key.name}?</DialogTitle>
                          <DialogDescription>
                            Applications using this key will no longer be able to send events.
                          </DialogDescription>
                        </DialogHeader>
                        {!readOnly && (
                          <form action={revokeKeyAction}>
                            <input type="hidden" name="org" value={org} />
                            <input type="hidden" name="id" value={key.id} />
                            <input type="hidden" name="projectId" value={projectId} />
                            <Button type="submit" variant="destructive">
                              Revoke key
                            </Button>
                          </form>
                        )}
                      </DialogContent>
                    </Dialog>
                  )}
                </div>
              ))}
          </div>
        )}
        {!readOnly && (
          <form action={action} className="space-y-3">
            <input type="hidden" name="org" value={org} />
            <input type="hidden" name="projectId" value={projectId} />
            <Label htmlFor="key-name">New key name</Label>
            <div className="flex gap-2">
              <Input
                id="key-name"
                name="name"
                required
                maxLength={60}
                placeholder="Production website"
              />
              <Button type="submit" variant="outline" disabled={pending}>
                {pending ? "Creating…" : "Create key"}
              </Button>
            </div>
          </form>
        )}
        {state.error && (
          <p role="alert" className="form-error mt-3">
            {state.error}
          </p>
        )}
        {state.secret && (
          <div role="status" className="mt-5 rounded-lg border border-primary/20 bg-primary/5 p-4">
            <p className="mb-2 text-xs font-medium text-primary">{state.success}</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all text-xs select-all">{state.secret}</code>
              <CopyButton text={state.secret} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

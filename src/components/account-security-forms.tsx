"use client";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { securityRequest } from "@/lib/auth-client";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

function PasswordField({
  id,
  label,
  fresh = false,
}: {
  id: string;
  label: string;
  fresh?: boolean;
}) {
  return (
    <div className="field">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={id}
        type="password"
        required
        minLength={fresh ? 10 : 1}
        maxLength={128}
        autoComplete={fresh ? "new-password" : "current-password"}
      />
      {fresh && <p className="field-hint">10–128 characters</p>}
    </div>
  );
}
function useFeedback() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function run(action: () => Promise<void>) {
    setPending(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not connect. Try again.");
    } finally {
      setPending(false);
    }
  }
  return {
    pending,
    run,
    setMessage,
    feedback: (
      <>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
      </>
    ),
  };
}
export function ForgotPasswordForm() {
  const { pending, run, setMessage, feedback } = useFeedback();
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void run(async () => {
          await securityRequest("request-password-reset", { email: form.get("email") });
          setMessage("If an account exists, we sent a link");
        });
      }}
    >
      <div className="field">
        <Label htmlFor="reset-email">Email</Label>
        <Input id="reset-email" name="email" type="email" required autoComplete="email" />
      </div>
      {feedback}
      <Button disabled={pending}>Send reset link</Button>
      <p>
        <Link href="/login" className="text-sm underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
export function ResetPasswordForm({ token }: { token?: string }) {
  const { pending, run, feedback } = useFeedback();
  const [done, setDone] = useState(false);
  if (done)
    return (
      <div className="space-y-5">
        <p role="status">Your password was changed. All sessions have been signed out.</p>
        <Link href="/login" className="underline">
          Sign in
        </Link>
      </div>
    );
  if (!token)
    return (
      <div className="space-y-5">
        <p role="alert">This reset link is missing or invalid.</p>
        <Link href="/forgot-password" className="underline">
          Request a new link
        </Link>
      </div>
    );
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void run(async () => {
          await securityRequest("reset-password", { token, newPassword: form.get("new-password") });
          setDone(true);
        });
      }}
    >
      <PasswordField id="new-password" label="New password" fresh />
      {feedback}
      <Button disabled={pending}>Reset password</Button>
      <p>
        <Link href="/forgot-password" className="text-sm underline">
          Request a new link
        </Link>
      </p>
    </form>
  );
}
export function TwoFactorSignIn({ onRestart }: { onRestart: () => void }) {
  const router = useRouter();
  const [backup, setBackup] = useState(false);
  const { pending, run, feedback } = useFeedback();
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void run(async () => {
          await securityRequest(
            backup ? "two-factor/verify-backup-code" : "two-factor/verify-totp",
            { code: form.get("code") },
          );
          router.replace("/app");
          router.refresh();
        });
      }}
    >
      <h2 className="text-xl font-medium">Two-factor authentication</h2>
      <p className="text-sm text-muted-foreground">
        {backup
          ? "Enter one of your single-use backup codes."
          : "Enter the 6-digit code from your authenticator app."}
      </p>
      <div className="field">
        <Label htmlFor="signin-code">{backup ? "Backup code" : "Authenticator code"}</Label>
        <Input
          key={String(backup)}
          id="signin-code"
          name="code"
          required
          autoComplete="one-time-code"
          inputMode={backup ? "text" : "numeric"}
          pattern={backup ? undefined : "[0-9]{6}"}
          maxLength={backup ? 32 : 6}
          autoFocus
        />
      </div>
      {feedback}
      <Button disabled={pending}>Verify and sign in</Button>
      <Button type="button" variant="ghost" disabled={pending} onClick={() => setBackup(!backup)}>
        {backup ? "Use authenticator code" : "Use a backup code"}
      </Button>
      <Button type="button" variant="ghost" disabled={pending} onClick={onRestart}>
        Start sign-in again
      </Button>
    </form>
  );
}
export function ChangePasswordForm() {
  const router = useRouter();
  const { pending, run, setMessage, feedback } = useFeedback();
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        const element = event.currentTarget;
        const form = new FormData(element);
        void run(async () => {
          await securityRequest("change-password", {
            currentPassword: form.get("current-password"),
            newPassword: form.get("change-password"),
            revokeOtherSessions: form.get("revoke-others") === "on",
          });
          element.reset();
          setMessage("Your password was changed.");
          window.dispatchEvent(new Event("pebble-sessions-changed"));
          router.refresh();
        });
      }}
    >
      <h2 className="text-xl font-medium">Change password</h2>
      <PasswordField id="current-password" label="Current password" />
      <PasswordField id="change-password" label="New password" fresh />
      <label className="flex items-center gap-2 text-sm">
        <input name="revoke-others" type="checkbox" defaultChecked />
        Sign out other sessions
      </label>
      {feedback}
      <Button disabled={pending}>Change password</Button>
    </form>
  );
}
type AccountSession = {
  id: string;
  summary: string;
  createdAt: string;
  lastActiveAt: string;
  current: boolean;
};
export function ActiveSessions() {
  const [sessions, setSessions] = useState<AccountSession[] | null>(null);
  const { pending, run, feedback } = useFeedback();
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void securityRequest("list-sessions")
        .then((data) => {
          if (active) {
            setSessions(data);
            setLoadError("");
          }
        })
        .catch(() => {
          if (active) setLoadError("Could not load sessions. Reload this page to try again.");
        });
    };
    refresh();
    window.addEventListener("pebble-sessions-changed", refresh);
    return () => {
      active = false;
      window.removeEventListener("pebble-sessions-changed", refresh);
    };
  }, []);
  return (
    <section className="space-y-5">
      <h2 className="text-xl font-medium">Active sessions</h2>
      {loadError && <p role="alert">{loadError}</p>}
      {!sessions && !loadError && <p role="status">Loading sessions…</p>}
      <ul className="space-y-5">
        {sessions?.map((session) => (
          <li key={session.id} className="space-y-2 border-b pb-4">
            <p className="font-medium">
              {session.summary}
              {session.current && (
                <span className="text-sm text-muted-foreground"> · This session</span>
              )}
            </p>
            <dl className="text-sm text-muted-foreground">
              <dt>Created</dt>
              <dd>
                <time dateTime={session.createdAt}>
                  {new Date(session.createdAt).toLocaleString()}
                </time>
              </dd>
              <dt>Last active</dt>
              <dd>
                <time dateTime={session.lastActiveAt}>
                  {new Date(session.lastActiveAt).toLocaleString()}
                </time>
              </dd>
            </dl>
            {!session.current && (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    await securityRequest("revoke-session", { sessionId: session.id });
                    setSessions((rows) => rows?.filter((row) => row.id !== session.id) ?? null);
                  })
                }
              >
                Revoke session
              </Button>
            )}
          </li>
        ))}
      </ul>
      {feedback}
    </section>
  );
}
export function TwoFactorSettings({ initiallyEnabled }: { initiallyEnabled: boolean }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initiallyEnabled);
  const [uri, setUri] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const { pending, run, setMessage, feedback } = useFeedback();
  function changed() {
    window.dispatchEvent(new Event("pebble-sessions-changed"));
    router.refresh();
  }
  async function manage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") ?? "enable";
    await run(async () => {
      const data = await securityRequest(`two-factor/${action}`, {
        password: form.get("2fa-password"),
      });
      element.reset();
      setCodes(null);
      if (action === "enable") setUri(data.totpURI);
      if (action === "generate-backup-codes") {
        setCodes(data.backupCodes);
        setMessage("Old backup codes no longer work.");
      }
      if (action === "disable") {
        setEnabled(false);
        setUri(null);
        setMessage("Two-factor authentication is disabled.");
      }
      changed();
    });
  }
  return (
    <section className="space-y-5">
      <h2 className="text-xl font-medium">Two-factor authentication</h2>
      <p className="text-sm text-muted-foreground">
        {enabled
          ? "Enabled. Sign-in requires an authenticator code or a backup code."
          : "Protect your account with an authenticator app."}
      </p>
      {uri ? (
        <div className="space-y-5">
          <p>Scan this QR code with your authenticator app, or enter the secret manually.</p>
          <div className="w-fit bg-white p-3">
            <QRCodeSVG
              value={uri}
              size={200}
              title="Scan to set up Pebble two-factor authentication"
            />
          </div>
          <div>
            <p className="text-sm font-medium">Setup secret</p>
            <code className="break-all select-all">{new URL(uri).searchParams.get("secret")}</code>
          </div>
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void run(async () => {
                const data = await securityRequest("two-factor/verify-totp", {
                  code: form.get("setup-code"),
                });
                setCodes(data.backupCodes);
                setEnabled(true);
                setUri(null);
                changed();
              });
            }}
          >
            <div className="field">
              <Label htmlFor="setup-code">Authenticator code</Label>
              <Input
                id="setup-code"
                name="setup-code"
                required
                pattern="[0-9]{6}"
                maxLength={6}
                inputMode="numeric"
                autoComplete="one-time-code"
              />
            </div>
            <Button disabled={pending}>Confirm and enable 2FA</Button>
          </form>
        </div>
      ) : (
        <form className="space-y-5" onSubmit={manage}>
          <PasswordField id="2fa-password" label="Password for two-factor settings" />
          {enabled ? (
            <div className="flex flex-wrap gap-2">
              <Button disabled={pending} name="action" value="generate-backup-codes">
                Regenerate backup codes
              </Button>
              <Button disabled={pending} variant="outline" name="action" value="disable">
                Disable 2FA
              </Button>
            </div>
          ) : (
            <Button disabled={pending} name="action" value="enable">
              Set up 2FA
            </Button>
          )}
        </form>
      )}
      {feedback}
      {codes && (
        <div className="space-y-4" role="status">
          <h3 className="font-medium">Save your backup codes</h3>
          <p className="text-sm">
            These 10 codes are shown once. Store them somewhere safe. Each code works only once.
          </p>
          <ul className="grid grid-cols-2 gap-2 font-mono text-sm select-all">
            {codes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
          <Button variant="outline" onClick={() => setCodes(null)}>
            I saved my backup codes
          </Button>
        </div>
      )}
    </section>
  );
}
export function DeleteAccountForm() {
  const router = useRouter();
  const { pending, run, feedback } = useFeedback();
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void run(async () => {
          await securityRequest("delete-user", {
            password: form.get("delete-password"),
            confirmation: form.get("confirmation"),
          });
          router.replace("/login");
          router.refresh();
        });
      }}
    >
      <h2 className="text-xl font-medium">Delete account</h2>
      <p className="text-sm text-muted-foreground">
        This permanently deletes your account and any organizations where you are the only member,
        including their projects and analytics data. Transfer ownership or remove other members
        first.
      </p>
      <PasswordField id="delete-password" label="Password to delete account" />
      <div className="field">
        <Label htmlFor="confirmation">Type DELETE to confirm</Label>
        <Input id="confirmation" name="confirmation" required pattern="DELETE" autoComplete="off" />
      </div>
      {feedback}
      <Button variant="destructive" disabled={pending}>
        Delete account permanently
      </Button>
    </form>
  );
}

"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createOrganizationAction, updateNameAction } from "@/server/actions";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

async function authRequest(path: string, body?: Record<string, unknown>) {
  const response = await fetch(
    `/api/auth/${path}`,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : { cache: "no-store" },
  );
  const data = await response.json();
  return { response, data };
}
export function SessionRefresh() {
  const pathname = usePathname();
  useEffect(() => {
    // Route response applies Better Auth's rolling Set-Cookie (RSCs cannot).
    // Keep active long-lived realtime tabs rolling as well as page navigations.
    const refresh = () => {
      if (document.visibilityState === "visible") void authRequest("get-session").catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 60 * 60 * 1000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [pathname]);
  return null;
}
export function SignOut() {
  const router = useRouter();
  const [error, setError] = useState("");
  return (
    <>
      <Button
        variant="ghost"
        onClick={async () => {
          try {
            const { response } = await authRequest("sign-out", {});
            if (!response.ok) throw new Error();
            router.replace("/login");
            router.refresh();
          } catch {
            setError("Could not sign out. Try again.");
          }
        }}
      >
        Sign out
      </Button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
export function ResendEmail({ initialEmail = "" }: { initialEmail?: string }) {
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        const email = String(new FormData(event.currentTarget).get("email") ?? "");
        setPending(true);
        try {
          const { response, data } = await authRequest("send-verification-email", { email });
          setMessage(
            response.ok
              ? "If your email still needs verification, a new link is on its way."
              : data.message,
          );
        } catch {
          setMessage("Could not send email. Try again.");
        } finally {
          setPending(false);
        }
      }}
    >
      <div className="field">
        <Label htmlFor="resend-email">Email</Label>
        <Input
          id="resend-email"
          name="email"
          type="email"
          defaultValue={initialEmail}
          autoComplete="email"
          required
        />
      </div>
      <Button disabled={pending}>Resend email</Button>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <p>
        <Link href="/login" className="text-sm underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
export function AuthForm({ signup = false }: { signup?: boolean }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [check, setCheck] = useState<{ email: string; signup: boolean } | null>(null);
  if (check)
    return (
      <div className="space-y-5">
        <h2 className="text-xl font-medium">
          {check.signup ? "Check your email" : "Verify your email"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {check.signup
            ? "Check your inbox for the next step to access Pebble."
            : "Verify your email address before signing in."}
        </p>
        <ResendEmail initialEmail={check.email} />
      </div>
    );
  return (
    <form
      className="space-y-5"
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const email = String(form.get("email") ?? "")
          .trim()
          .toLowerCase();
        setPending(true);
        setError("");
        try {
          const { response, data } = await authRequest(signup ? "sign-up/email" : "sign-in/email", {
            email,
            password: form.get("password"),
            ...(signup
              ? { name: form.get("name"), termsAccepted: form.get("terms") === "on" }
              : {}),
          });
          if (response.ok) {
            if (signup) setCheck({ email, signup: true });
            else {
              router.replace("/app");
              router.refresh();
            }
          } else if (data.code === "EMAIL_NOT_VERIFIED") setCheck({ email, signup: false });
          else setError(data.message ?? "Could not sign in. Try again.");
        } catch {
          setError("Could not connect. Try again.");
        } finally {
          setPending(false);
        }
      }}
    >
      {signup && (
        <div className="field">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" required minLength={1} maxLength={80} autoComplete="name" />
        </div>
      )}
      <div className="field">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" required autoComplete="email" />
      </div>
      <div className="field">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          required
          minLength={signup ? 10 : 1}
          maxLength={128}
          autoComplete={signup ? "new-password" : "current-password"}
        />
        {signup && <p className="field-hint">10–128 characters</p>}
      </div>
      {signup && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="terms" required className="mt-1" />
          <span>
            I agree to the{" "}
            <Link className="underline" href="/legal/terms">
              Terms
            </Link>{" "}
            and{" "}
            <Link className="underline" href="/legal/privacy">
              Privacy Policy
            </Link>
            .
          </span>
        </label>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Please wait…" : signup ? "Create account" : "Sign in"}
      </Button>
      <p className="text-sm">
        <Link className="underline" href={signup ? "/login" : "/signup"}>
          {signup ? "Already have an account? Sign in" : "New to Pebble? Start free"}
        </Link>
      </p>
    </form>
  );
}
export function VerifyEmail({ token }: { token?: string }) {
  const router = useRouter();
  const started = useRef(false);
  const [error, setError] = useState(token ? "" : "This verification link is missing or invalid.");
  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    void authRequest(`verify-email?token=${encodeURIComponent(token)}`)
      .then(({ response, data }) => {
        if (response.ok) {
          router.replace("/app");
          router.refresh();
        } else setError(data.message ?? "This verification link has expired or is invalid.");
      })
      .catch(() => setError("Could not verify your email. Try opening the link again."));
  }, [token, router]);
  return error ? (
    <div className="space-y-5">
      <p role="alert" className="form-error">
        {error}
      </p>
      <ResendEmail />
    </div>
  ) : (
    <p role="status">Verifying your email…</p>
  );
}
export function OrganizationForm() {
  const [state, action, pending] = useActionState(createOrganizationAction, {});
  return (
    <form action={action} className="space-y-5">
      <div className="field">
        <Label htmlFor="org-name">Organization name</Label>
        <Input name="name" id="org-name" minLength={1} maxLength={60} required />
      </div>
      {state.error && (
        <p role="alert" className="form-error">
          {state.error}
        </p>
      )}
      <Button disabled={pending}>Create organization</Button>
    </form>
  );
}
export function AccountForm({ name }: { name: string }) {
  const [state, action, pending] = useActionState(updateNameAction, {});
  return (
    <form action={action} className="space-y-5">
      <div className="field">
        <Label htmlFor="account-name">Name</Label>
        <Input
          name="name"
          id="account-name"
          defaultValue={name}
          minLength={1}
          maxLength={80}
          required
        />
      </div>
      {state.error && (
        <p role="alert" className="form-error">
          {state.error}
        </p>
      )}
      {state.success && <p role="status">{state.success}</p>}
      <Button disabled={pending}>Save name</Button>
    </form>
  );
}

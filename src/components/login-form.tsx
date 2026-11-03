"use client";
import { useActionState } from "react";
import { ArrowRight, LockKeyhole } from "lucide-react";
import { loginAction } from "@/server/actions";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Button } from "./ui/button";

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, {});
  return (
    <form action={action} className="space-y-5">
      <div className="field">
        <Label htmlFor="password">Admin password</Label>
        <div className="relative">
          <LockKeyhole size={15} className="absolute left-3 top-3 z-10 text-muted-foreground" />
          <Input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            autoFocus
            placeholder="Your password"
            className="h-11 pl-10"
          />
        </div>
      </div>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <Button type="submit" className="h-11 w-full justify-between px-4" disabled={pending}>
        {pending ? "Signing in…" : "Step inside"}
        <ArrowRight size={16} />
      </Button>
    </form>
  );
}

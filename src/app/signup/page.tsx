import { PublicShell } from "@/components/public-shell";
import { AuthForm } from "@/components/account-forms";
export default function SignupPage() {
  return (
    <PublicShell>
      <section className="mx-auto max-w-sm py-12">
        <h1 className="mb-3 text-3xl font-medium">Your little corner starts here.</h1>
        <p className="mb-8 text-sm text-muted-foreground">Create your Pebble account.</p>
        <AuthForm signup />
      </section>
    </PublicShell>
  );
}

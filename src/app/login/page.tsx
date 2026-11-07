import { redirect } from "next/navigation";
import { currentUser } from "@/server/auth";
import { PublicShell } from "@/components/public-shell";
import { AuthForm } from "@/components/account-forms";
export const dynamic = "force-dynamic";
export default async function LoginPage() {
  if (await currentUser()) redirect("/app");
  return (
    <PublicShell>
      <section className="mx-auto max-w-sm py-12">
        <h1 className="mb-3 text-3xl font-medium">Welcome to your corner.</h1>
        <p className="mb-8 text-sm text-muted-foreground">Sign in to your Pebble account.</p>
        <AuthForm />
      </section>
    </PublicShell>
  );
}

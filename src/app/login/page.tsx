import { redirect } from "next/navigation";
import { verifyAdmin } from "@/server/auth";
import { adminPasswordHash } from "@/server/config";
import { Brand, PebbleMark } from "@/components/brand";
import { LoginForm } from "@/components/login-form";
import { ThemeToggle } from "@/components/theme-provider";

export const dynamic = "force-dynamic";
export default async function LoginPage() {
  if (await verifyAdmin()) redirect("/");
  const configured = Boolean(process.env.DATABASE_URL && adminPasswordHash());
  return (
    <main className="login-page">
      <div className="login-top">
        <Brand />
        <ThemeToggle />
      </div>
      <div className="login-center">
        <div className="login-art">
          <PebbleMark className="size-24 text-primary" />
          <span className="orbit orbit-one" />
          <span className="orbit orbit-two" />
        </div>
        <p className="eyebrow mb-4">A LITTLE CLARITY</p>
        <h1 className="mb-3 text-4xl font-medium tracking-[-1.5px]">Welcome to your corner.</h1>
        <p className="mb-9 text-sm leading-relaxed text-muted-foreground">
          A quieter place to understand
          <br />
          the things you’re building.
        </p>
        <div className="text-left">
          {configured ? (
            <LoginForm />
          ) : (
            <div className="panel p-6">
              <h2 className="mb-2 font-medium">Let’s get Pebble ready.</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Add your Postgres connection and admin password hash to <code>.env.local</code>,
                then run the database migrations. The README walks you through the three steps.
              </p>
            </div>
          )}
        </div>
        <p className="mt-7 text-xs text-muted-foreground">
          Just you, your websites, and a little perspective.
        </p>
      </div>
      <footer className="login-footer">Small details. A clearer picture.</footer>
    </main>
  );
}

import { PublicShell } from "@/components/public-shell";
import { ForgotPasswordForm } from "@/components/account-security-forms";
export default function ForgotPasswordPage() {
  return (
    <PublicShell>
      <section className="mx-auto max-w-sm py-12">
        <h1 className="mb-8 text-3xl font-medium">Forgot password?</h1>
        <ForgotPasswordForm />
      </section>
    </PublicShell>
  );
}

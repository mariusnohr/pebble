import { PublicShell } from "@/components/public-shell";
import { ResetPasswordForm } from "@/components/account-security-forms";
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const token = (await searchParams).token;
  return (
    <PublicShell>
      <section className="mx-auto max-w-sm py-12">
        <h1 className="mb-8 text-3xl font-medium">Reset password</h1>
        <ResetPasswordForm token={typeof token === "string" ? token : undefined} />
      </section>
    </PublicShell>
  );
}

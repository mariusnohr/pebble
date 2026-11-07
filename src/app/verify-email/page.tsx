import { PublicShell } from "@/components/public-shell";
import { VerifyEmail } from "@/components/account-forms";
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  return (
    <PublicShell>
      <section className="mx-auto max-w-sm py-12">
        <h1 className="mb-8 text-3xl font-medium">Verify your email</h1>
        <VerifyEmail token={(await searchParams).token} />
      </section>
    </PublicShell>
  );
}

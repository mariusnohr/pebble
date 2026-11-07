import { requireUser } from "@/server/auth";
import { SessionRefresh } from "@/components/account-forms";
export const dynamic = "force-dynamic";
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  return (
    <>
      <SessionRefresh />
      {children}
    </>
  );
}

import "server-only";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { auth } from "./auth-options";
import { appOrigin } from "./config";
import { touchSession } from "./account-security";
export { appOrigin } from "./config";

export async function currentUser() {
  const session = await auth.api.getSession({
    headers: await headers(),
    query: { disableRefresh: true },
  });
  if (session?.user.emailVerified) await touchSession(session.session.id);
  return session?.user.emailVerified ? session.user : null;
}
export async function requireUser() {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}
export async function requireMemberUser() {
  const user = await currentUser();
  if (!user) notFound();
  return user;
}
export async function assertSameOrigin() {
  if ((await headers()).get("origin") !== appOrigin()) throw new Error("Invalid request origin.");
}

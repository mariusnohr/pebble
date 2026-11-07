import { redirect } from "next/navigation";
import { currentUser } from "@/server/auth";
export const dynamic = "force-dynamic";
export default async function Home() {
  redirect((await currentUser()) ? "/app" : "/login");
}

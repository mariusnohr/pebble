"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export function SettingsNavigation({ org, canManage }: { org: string; canManage: boolean }) {
  const pathname = usePathname();
  const base = `/app/${org}/settings`;
  return (
    <nav className="project-tabs" aria-label="Organization settings">
      {canManage && (
        <Link
          href={base}
          className={cn(pathname === base && "selected")}
          aria-current={pathname === base ? "page" : undefined}
        >
          General
        </Link>
      )}
    </nav>
  );
}

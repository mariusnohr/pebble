"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight, LayoutGrid, Globe2, Radio, ArrowLeft, Settings } from "lucide-react";
import type { Project } from "@/db/schema";
import { Brand } from "./brand";
import { ThemeToggle } from "./theme-provider";
import { SignOut } from "./account-forms";
import { ProjectDialog } from "./project-form";
import { cn } from "@/lib/utils";

export function AppShell({
  projects,
  children,
  organization,
  organizations,
  user,
  canManage,
}: {
  projects: Project[];
  organization: { name: string; slug: string };
  organizations: { id: string; name: string; slug: string }[];
  user: { name: string; email: string };
  canManage: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const org = organization.slug;
  const settingsActive =
    pathname === `/app/${org}/settings` || pathname.startsWith(`/app/${org}/settings/`);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link href="/" aria-label="Pebble home" className="brand-link">
          <Brand />
        </Link>
        <div className="sidebar-body">
          <details className="mb-5 px-3 text-sm">
            <summary className="cursor-pointer">{organization.name}</summary>
            <nav aria-label="Organizations" className="mt-3 space-y-2">
              {organizations.map((item) => (
                <Link className="block" key={item.id} href={`/app/${item.slug}`} prefetch={false}>
                  {item.name}
                </Link>
              ))}
              <Link className="block underline" href="/app/new">
                Create organization
              </Link>
            </nav>
          </details>
          <Link
            href={`/app/${org}`}
            className={cn("nav-item", pathname === `/app/${org}` && "active")}
          >
            <LayoutGrid size={16} />
            All projects<span className="ml-auto text-xs opacity-50">{projects.length}</span>
          </Link>
          {canManage && (
            <Link
              href={`/app/${org}/settings`}
              className={cn("nav-item", settingsActive && "active")}
            >
              <Settings size={16} />
              Settings
            </Link>
          )}
          <div className="mt-9 flex items-center justify-between">
            <div className="nav-label mb-0!">YOUR WEBSITES</div>
            {canManage && <ProjectDialog org={org} compact />}
          </div>
          <nav className="mt-3 space-y-1" aria-label="Projects">
            {projects.map((project, index) => (
              <Link
                key={project.id}
                href={`/app/${org}/projects/${project.id}`}
                className={cn("nav-item", pathname.includes(project.id) && "active")}
              >
                <span className={`project-dot dot-${index % 4}`} />{" "}
                <span className="truncate">{project.name}</span>
                {project.paused && (
                  <span className="ml-auto text-[10px] text-muted-foreground">Paused</span>
                )}
              </Link>
            ))}
          </nav>
          {!projects.length && (
            <p className="px-3 pt-3 text-xs leading-relaxed text-muted-foreground">
              A little insight starts
              <br />
              with your first website.
            </p>
          )}
          <div className="sidebar-note">
            <Globe2 size={18} className="mb-3 text-primary/70" />
            <p className="font-medium">
              Small details.
              <br />A clearer picture.
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Your websites, all in one
              <br />
              quiet corner.
            </p>
          </div>
        </div>
        <div className="sidebar-footer">
          <details className="mb-4 text-sm">
            <summary className="cursor-pointer">{user.name}</summary>
            <p className="my-2 break-all text-xs text-muted-foreground">{user.email}</p>
            <Link className="block underline" href="/app/account">
              Account
            </Link>
            <SignOut />
          </details>
          <div className="flex items-center justify-between">
            <ThemeToggle />
            <span className="text-[10px] text-muted-foreground">pebble / 0.1</span>
          </div>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <Globe2 size={14} /> Workspace <span className="mx-1 opacity-40">/</span>
            <span className="text-foreground">
              {pathname === `/app/${org}`
                ? "All projects"
                : settingsActive
                  ? "Settings"
                  : (projects.find((p) => pathname.includes(p.id))?.name ?? "Project")}
            </span>
          </span>
          <span className="topbar-caption">
            A little clarity, every day.
            <ArrowUpRight size={13} />
          </span>
        </header>
        <main className="main-content">{children}</main>
        <footer className="main-footer">
          <span>Made for the things you build.</span>
          <span className="flex items-center gap-1.5">
            <span className="size-1 rounded-full bg-primary" />
            Pebble Analytics
          </span>
        </footer>
      </div>
    </div>
  );
}

export function ProjectNavigation({ project, org }: { project: Project; org: string }) {
  const pathname = usePathname();
  const base = `/app/${org}/projects/${project.id}`;
  return (
    <>
      <Link
        href={`/app/${org}`}
        className="mb-6 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={12} />
        All projects
      </Link>
      <div className="mb-7 flex items-start justify-between gap-3">
        <div>
          <div className="mb-3 flex items-center gap-2.5">
            <span className="site-icon">
              <Globe2 size={19} />
            </span>
            <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            {project.origins.map((o) => new URL(o).host).join(" · ")}
          </p>
        </div>
        <span className={cn("status-pill", project.paused && "paused")}>
          <span className="size-1.5 rounded-full bg-current" />
          {project.paused ? "Collection paused" : "Collection enabled"}
        </span>
      </div>
      <nav className="project-tabs" aria-label="Project navigation">
        {[
          ["", "Overview"],
          ["/realtime", "Realtime"],
          ["/events", "Events"],
          ["/settings", "Settings"],
        ].map(([suffix, label]) => (
          <Link
            key={label}
            href={base + suffix}
            className={cn(pathname === base + suffix && "selected")}
          >
            {suffix === "/realtime" && <Radio size={13} />}
            {label}
          </Link>
        ))}
      </nav>
    </>
  );
}

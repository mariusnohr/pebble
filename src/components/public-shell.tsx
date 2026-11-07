import "server-only";
import Link from "next/link";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-provider";
import { legalPages } from "@/server/legal";

export function PublicShell({ children }: { children: React.ReactNode }) {
  const supportEmail = process.env.SUPPORT_EMAIL?.trim();

  return (
    <div className="public-shell">
      <a href="#public-content" className="public-skip-link">
        Skip to content
      </a>
      <header className="public-header">
        <Link href="/" aria-label="Pebble home">
          <Brand />
        </Link>
        <nav aria-label="Public navigation">
          <Link href="/login">Sign in</Link>
          <Link href="/signup">Start free</Link>
        </nav>
      </header>
      <main id="public-content" className="public-main" tabIndex={-1}>
        {children}
      </main>
      <footer className="public-footer">
        <div className="public-footer-links">
          <nav aria-label="Legal">
            {legalPages.map(({ slug, label }) => (
              <Link key={slug} href={`/legal/${slug}`}>
                {label}
              </Link>
            ))}
          </nav>
          {supportEmail && (
            <p>
              <a href={`mailto:${supportEmail}`}>{supportEmail}</a>
            </p>
          )}
        </div>
        <ThemeToggle />
      </footer>
    </div>
  );
}

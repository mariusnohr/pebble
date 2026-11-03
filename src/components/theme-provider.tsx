"use client";
import { ThemeProvider as Provider, useTheme } from "next-themes";
import { Sun, Moon, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <Provider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      {children}
    </Provider>
  );
}
export function ThemeToggle() {
  const { setTheme } = useTheme();
  return (
    <div
      className="flex items-center rounded-lg border bg-background p-0.5"
      aria-label="Color theme"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setTheme("light")}
        aria-label="Light theme"
      >
        <Sun size={14} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setTheme("dark")}
        aria-label="Dark theme"
      >
        <Moon size={14} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setTheme("system")}
        aria-label="System theme"
      >
        <Monitor size={14} />
      </Button>
    </div>
  );
}

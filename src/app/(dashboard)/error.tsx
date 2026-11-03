"use client";
import { Button } from "@/components/ui/button";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="empty-workspace">
      <h2>We couldn’t load this view.</h2>
      <p>Check the database connection and try again.</p>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}

import Link from "next/link";
export default function NotFound() {
  return (
    <div className="empty-workspace">
      <h2>This corner doesn’t exist.</h2>
      <p>The project may have been removed.</p>
      <Link href="/" className="text-sm text-primary underline underline-offset-4">
        Back to your projects
      </Link>
    </div>
  );
}

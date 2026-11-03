export function PebbleMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" className={className}>
      <path
        d="M5 22C5 16 10 12 17 12c8 0 14 5 14 11s-6 10-14 10S5 28 5 22Z"
        fill="currentColor"
        opacity=".25"
      />
      <path d="M9 13c0-6 4-10 10-10s11 4 11 9-5 9-11 9-10-3-10-8Z" fill="currentColor" />
    </svg>
  );
}
export function Brand() {
  return (
    <span className="flex items-center gap-2.5 text-[25px] font-semibold tracking-[-1.2px]">
      <PebbleMark className="size-8 text-primary" />
      pebble
      <span className="mb-3 size-1.5 rounded-full bg-primary/45" />
    </span>
  );
}

import { createTracker } from "./browser.js";

type Tracker = ReturnType<typeof createTracker>;
declare global {
  interface Window {
    pebble?: Tracker | { q: [string, ...unknown[]][] };
  }
}
const script = document.currentScript as HTMLScriptElement | null;
if (script?.dataset.project && (!window.pebble || "q" in window.pebble)) {
  const queue = window.pebble && "q" in window.pebble ? window.pebble.q : [];
  const tracker = createTracker({
    endpoint: new URL(script.src).origin,
    projectId: script.dataset.project,
    enabled: script.dataset.consent !== "required",
  });
  window.pebble = tracker;
  for (const [method, ...args] of queue) {
    if (method === "track")
      tracker.track(args[0] as string, args[1] as Parameters<Tracker["track"]>[1]);
    if (method === "setEnabled") tracker.setEnabled(Boolean(args[0]));
  }
}

import { deliver } from "./transport.js";
import type { EventOptions, Message, Properties, TrackingContext } from "./types.js";
export type { EventOptions, TrackingContext, DeliveryResult, Properties } from "./types.js";

type Identity = TrackingContext & { expires: number; active: number };
export type BrowserConfig = {
  endpoint: string;
  projectId: string;
  enabled?: boolean;
  autoPageviews?: boolean;
  onError?: (message: string) => void;
};

export function createTracker(config: BrowserConfig) {
  const key = `pebble:${config.projectId}`;
  let enabled = config.enabled ?? true;
  let memory: Identity | undefined;
  let destroyed = false;
  let previousPath = "";
  let pageviewVisit = "";
  let queued: Message[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  const url = new URL("/api/v1/collect", config.endpoint).href;

  function getContext(): TrackingContext | undefined {
    if (!enabled || destroyed) return;
    const now = Date.now();
    let identity = memory;
    try {
      const stored = localStorage.getItem(key);
      if (stored) identity = JSON.parse(stored) as Identity;
    } catch {
      /* Storage may be unavailable. */
    }
    if (
      !identity ||
      typeof identity.expires !== "number" ||
      identity.expires <= now ||
      !identity.visitorId
    ) {
      identity = {
        visitorId: crypto.randomUUID(),
        visitId: crypto.randomUUID(),
        expires: now + 30 * 86400000,
        active: now,
      };
    }
    if (!identity.visitId || typeof identity.active !== "number" || now - identity.active > 1800000)
      identity.visitId = crypto.randomUUID();
    identity.active = now;
    memory = identity;
    try {
      localStorage.setItem(key, JSON.stringify(identity));
    } catch {
      /* Keep an in-memory identity for this page. */
    }
    return { visitorId: identity.visitorId, visitId: identity.visitId };
  }

  function metadata() {
    const params = new URLSearchParams(location.search);
    const read = (name: string) => params.get(name)?.slice(0, 200) || undefined;
    let referrer: string | undefined;
    try {
      referrer = new URL(document.referrer).origin;
    } catch {
      /* Direct visit. */
    }
    return {
      referrer,
      language: navigator.language,
      utm: {
        source: read("utm_source"),
        medium: read("utm_medium"),
        campaign: read("utm_campaign"),
      },
    };
  }

  async function flush() {
    if (inFlight) {
      await inFlight;
      if (queued.length) await flush();
      return;
    }
    if (!queued.length || !enabled || destroyed) return;
    const batch = queued.splice(0, 20);
    inFlight = (async () => {
      const result = await deliver(url, batch, { projectId: config.projectId, keepalive: true });
      if (!result.ok) config.onError?.(result.error);
    })();
    try {
      await inFlight;
    } finally {
      inFlight = undefined;
    }
    if (queued.length) await flush();
  }

  function enqueue(message: Omit<Message, "id"> & { id?: string }) {
    const context = getContext();
    if (!context) return;
    if (
      message.type === "heartbeat" &&
      config.autoPageviews !== false &&
      pageviewVisit !== context.visitId
    )
      message.type = "pageview";
    if (message.type === "pageview") pageviewVisit = context.visitId;
    if (queued.length >= 100) {
      config.onError?.("Pebble queue is full");
      return;
    }
    queued.push({
      ...metadata(),
      ...message,
      path: message.path?.split(/[?#]/)[0],
      ...context,
      id: message.id ?? crypto.randomUUID(),
    });
    clearTimeout(timer);
    timer = setTimeout(
      () => {
        void flush();
      },
      queued.length >= 20 ? 0 : 150,
    );
  }

  function pageview(path = location.pathname, options: Pick<EventOptions, "id"> = {}) {
    if (document.visibilityState !== "visible") return;
    previousPath = path;
    enqueue({ type: "pageview", path, ...options });
  }
  function navigation() {
    if (config.autoPageviews !== false && location.pathname !== previousPath) pageview();
  }
  const originalPush = history.pushState;
  const originalReplace = history.replaceState;
  const push: History["pushState"] = function (this: History, ...args) {
    originalPush.apply(this, args);
    navigation();
  };
  const replace: History["replaceState"] = function (this: History, ...args) {
    originalReplace.apply(this, args);
    navigation();
  };
  if (config.autoPageviews !== false) {
    history.pushState = push;
    history.replaceState = replace;
  }
  const visibility = () => {
    if (document.visibilityState === "visible") navigation();
    else void flush();
  };
  const pagehide = () => {
    void flush();
  };
  window.addEventListener("popstate", navigation);
  window.addEventListener("pagehide", pagehide);
  document.addEventListener("visibilitychange", visibility);
  const heartbeat = setInterval(() => {
    if (document.visibilityState === "visible")
      enqueue({ type: "heartbeat", path: location.pathname });
  }, 20000);
  if (config.autoPageviews !== false) navigation();

  return {
    track(name: string, properties: Properties = {}, options: Pick<EventOptions, "id"> = {}) {
      enqueue({ type: "event", name, properties, path: location.pathname, ...options });
    },
    pageview,
    getContext,
    flush,
    setEnabled(value: boolean) {
      enabled = value;
      if (!value) {
        queued = [];
        memory = undefined;
        try {
          localStorage.removeItem(key);
        } catch {
          /* No storage. */
        }
      } else {
        previousPath = "";
        navigation();
      }
    },
    destroy() {
      destroyed = true;
      queued = [];
      clearTimeout(timer);
      clearInterval(heartbeat);
      window.removeEventListener("popstate", navigation);
      window.removeEventListener("pagehide", pagehide);
      document.removeEventListener("visibilitychange", visibility);
      if (history.pushState === push) history.pushState = originalPush;
      if (history.replaceState === replace) history.replaceState = originalReplace;
    },
  };
}

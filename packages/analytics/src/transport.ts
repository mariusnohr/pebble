import type { DeliveryResult, Message } from "./types.js";

export async function deliver(
  url: string,
  events: Message[],
  options: {
    projectId?: string;
    apiKey?: string;
    timeoutMs?: number;
    retries?: number;
    keepalive?: boolean;
  } = {},
): Promise<DeliveryResult> {
  let last: DeliveryResult = { ok: false, error: "Delivery failed" };
  const body = JSON.stringify({
    ...(options.projectId ? { projectId: options.projectId } : {}),
    events,
  });
  if (new TextEncoder().encode(body).length > 32768)
    return { ok: false, error: "Batch exceeds 32 KiB" };
  const retries = Math.min(Math.max(options.retries ?? 2, 0), 3);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        body,
        credentials: "omit",
        keepalive: options.keepalive ?? false,
        headers: options.apiKey
          ? { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` }
          : { "Content-Type": "text/plain" },
        signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
      });
      if (response.ok) {
        const result = (await response.json()) as { accepted: number; duplicates: number };
        return { ok: true, accepted: result.accepted, duplicates: result.duplicates };
      }
      last = { ok: false, error: `Pebble returned ${response.status}`, status: response.status };
      // Do not immediately retry rate limits; let the caller decide when to resume.
      if (response.status < 500) return last;
    } catch {
      last = { ok: false, error: "Pebble could not be reached" };
    }
    if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** attempt));
  }
  return last;
}

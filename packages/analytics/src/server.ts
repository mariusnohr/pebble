import { randomUUID } from "node:crypto";
import { deliver } from "./transport.js";
import type { EventOptions, Message, Properties } from "./types.js";
export type { EventOptions, TrackingContext, DeliveryResult, Properties } from "./types.js";

export function createClient(config: {
  endpoint: string;
  apiKey: string;
  timeoutMs?: number;
  retries?: number;
}) {
  if (!config.apiKey.startsWith("pb_")) throw new Error("A Pebble server API key is required.");
  const url = new URL("/api/v1/events", config.endpoint).href;
  const send = (message: Message) => deliver(url, [message], config);
  return {
    track(name: string, properties: Properties = {}, options: EventOptions = {}) {
      return send({
        id: options.id ?? randomUUID(),
        type: "event",
        name,
        properties,
        timestamp: options.timestamp ?? new Date().toISOString(),
        path: options.path,
        ...options.context,
      });
    },
    pageview(path: string, options: EventOptions = {}) {
      return send({
        id: options.id ?? randomUUID(),
        type: "pageview",
        path,
        timestamp: options.timestamp ?? new Date().toISOString(),
        ...options.context,
      });
    },
  };
}

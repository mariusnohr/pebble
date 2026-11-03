export type Properties = Record<string, string | number | boolean | null>;
export type TrackingContext = { visitorId: string; visitId: string };
export type EventOptions = {
  id?: string;
  timestamp?: string;
  path?: string;
  context?: TrackingContext;
};
export type Message = {
  id: string;
  type: "pageview" | "event" | "heartbeat";
  timestamp?: string;
  visitorId?: string;
  visitId?: string;
  path?: string;
  name?: string;
  properties?: Properties;
  referrer?: string;
  language?: string;
  utm?: { source?: string; medium?: string; campaign?: string };
};
export type DeliveryResult =
  | { ok: true; accepted: number; duplicates: number }
  | { ok: false; error: string; status?: number };

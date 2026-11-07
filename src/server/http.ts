import { IngestError } from "./ingestion";

export async function readJson(request: Request, maxBytes = 32768) {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes)
    throw new IngestError("Payload too large.", 413, "payload_too_large");
  const reader = request.body?.getReader();
  if (!reader) throw new IngestError("Missing request body.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new IngestError("Payload too large.", 413, "payload_too_large");
      }
      chunks.push(value);
    }
    const combined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder().decode(combined));
  } catch (error) {
    if (error instanceof IngestError) throw error;
    throw new IngestError("Invalid JSON body.");
  } finally {
    reader.releaseLock();
  }
}

export function apiError(error: unknown, headers?: HeadersInit) {
  if (error instanceof IngestError) {
    const responseHeaders = new Headers(headers);
    if (error.code === "rate_limited") responseHeaders.set("Retry-After", "60");
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: responseHeaders },
    );
  }
  console.error("Analytics request failed", error instanceof Error ? error.name : "UnknownError");
  return Response.json(
    { error: "Analytics is temporarily unavailable.", code: "unavailable" },
    { status: 503, headers },
  );
}

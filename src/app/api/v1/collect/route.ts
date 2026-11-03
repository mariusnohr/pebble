import { envelopeSchema } from "@/lib/contracts";
import { ingest, IngestError } from "@/server/ingestion";
import { apiError, readJson } from "@/server/http";
import { clientAddress, rateLimit } from "@/server/rate-limit";

export const runtime = "nodejs";

function cors(request: Request) {
  return {
    "Access-Control-Allow-Origin": request.headers.get("origin") ?? "null",
    Vary: "Origin",
    "Cache-Control": "no-store",
  };
}

export async function OPTIONS(request: Request) {
  return new Response(null, {
    status: 204,
    headers: {
      ...cors(request),
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600",
    },
  });
}

export async function POST(request: Request) {
  const responseHeaders = cors(request);
  try {
    if (!request.headers.get("origin") || request.headers.get("origin") === "null")
      throw new IngestError("A website origin is required.", 403);
    if (!(await rateLimit(`collect:${clientAddress(request.headers)}`, 6000)))
      return Response.json(
        { error: "Rate limit exceeded." },
        { status: 429, headers: { ...responseHeaders, "Retry-After": "60" } },
      );
    const parsed = envelopeSchema.safeParse(await readJson(request));
    if (!parsed.success || !parsed.data.projectId)
      throw new IngestError("Invalid tracking payload.");
    if (!(await rateLimit(`project:${parsed.data.projectId}`, 6000)))
      throw new IngestError("Project rate limit exceeded.", 429);
    const result = await ingest(parsed.data.projectId, parsed.data.events, "browser", {
      origin: request.headers.get("origin")!,
      userAgent: request.headers.get("user-agent") ?? "",
    });
    return Response.json(result, { headers: responseHeaders });
  } catch (error) {
    return apiError(error, responseHeaders);
  }
}

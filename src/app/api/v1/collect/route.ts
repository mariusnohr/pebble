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
    if (!(await rateLimit(`collect:${clientAddress(request.headers)}`, 600)))
      throw new IngestError("Rate limit exceeded.", 429, "rate_limited");
    const payload: unknown = await readJson(request);
    // Identify the project before validating the batch so invalid messages also
    // consume its rate limit. Unreadable JSON still consumes the client IP limit.
    const projectId = envelopeSchema.shape.projectId.safeParse(
      payload && typeof payload === "object" && "projectId" in payload
        ? payload.projectId
        : undefined,
    );
    if (
      projectId.success &&
      projectId.data &&
      !(await rateLimit(`project:${projectId.data}`, 6000))
    )
      throw new IngestError("Project rate limit exceeded.", 429, "rate_limited");
    const parsed = envelopeSchema.safeParse(payload);
    if (!parsed.success || !parsed.data.projectId)
      throw new IngestError("Invalid tracking payload.");
    const result = await ingest(parsed.data.projectId, parsed.data.events, "browser", {
      origin: request.headers.get("origin") ?? undefined,
      userAgent: request.headers.get("user-agent") ?? "",
    });
    return Response.json(result, { headers: responseHeaders });
  } catch (error) {
    return apiError(error, responseHeaders);
  }
}

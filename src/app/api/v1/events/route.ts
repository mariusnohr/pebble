import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { apiKeys } from "@/db/schema";
import { envelopeSchema } from "@/lib/contracts";
import { hashToken } from "@/server/crypto";
import { apiError, readJson } from "@/server/http";
import { ingest, IngestError } from "@/server/ingestion";
import { rateLimit } from "@/server/rate-limit";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const token = request.headers
      .get("authorization")
      ?.match(/^Bearer (pb_[A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) throw new IngestError("A valid project API key is required.", 401);
    const [key] = await getDb()
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.tokenHash, hashToken(token)), isNull(apiKeys.revokedAt)))
      .limit(1);
    if (!key) throw new IngestError("Invalid or revoked API key.", 401);
    if (!(await rateLimit(`server:${key.projectId}`, 6000)))
      throw new IngestError("Rate limit exceeded.", 429);
    const parsed = envelopeSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new IngestError("Invalid tracking payload.");
    if (parsed.data.projectId && parsed.data.projectId !== key.projectId)
      throw new IngestError("API key belongs to another project.", 403);
    const result = await ingest(key.projectId, parsed.data.events, "server");
    await getDb().update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id));
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error, { "Cache-Control": "no-store" });
  }
}

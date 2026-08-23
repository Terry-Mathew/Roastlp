import { createDatabase } from "../../../../../db/client";
import { resolveAuditStatus } from "../../../../../lib/audit-status";

export const runtime = "nodejs";

function json(status: number, body: object) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
    },
  });
}

/** Coarse progress polling. No capability required; no secrets returned. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    return json(200, { state: "unknown" });

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return json(503, { state: "unknown" });

  const database = createDatabase(databaseUrl);
  try {
    const status = await resolveAuditStatus(database.db, id);
    return json(200, status);
  } catch {
    return json(503, { state: "unknown" });
  } finally {
    await database.close();
  }
}

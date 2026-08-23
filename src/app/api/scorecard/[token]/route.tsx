import { ImageResponse } from "next/og";

import { createDatabase } from "../../../../db/client";
import { DrizzleReportRepository } from "../../../../db/report-repository";
import { storedReportSchema } from "../../../../lib/roast-schema";
import { verifyScorecardToken } from "../../../../lib/scorecard-token";

export const runtime = "nodejs";

/**
 * POR-24: the shareable scorecard. Contains brand, domain, score and verdict
 * ONLY — never email, payment ids, report tokens or private URLs. The signed,
 * short-lived token in the path is the sole authorization.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const hmacKey = process.env.ABUSE_SIGNAL_HMAC_KEY;
  const databaseUrl = process.env.DATABASE_URL;
  if (!hmacKey || !databaseUrl)
    return new Response("Not found", { status: 404 });

  const payload = verifyScorecardToken(token, hmacKey);
  if (!payload) return new Response("Not found", { status: 404 });

  const database = createDatabase(databaseUrl);
  try {
    const reports = new DrizzleReportRepository(database.db);
    const [report, canonicalUrl] = await Promise.all([
      reports.findByRoastId(payload.roastId),
      reports.canonicalUrlForRoast(payload.roastId),
    ]);
    if (!report || !canonicalUrl)
      return new Response("Not found", { status: 404 });

    const parsed = storedReportSchema.safeParse(report.report);
    if (!parsed.success) return new Response("Not found", { status: 404 });
    const hostname = new URL(canonicalUrl).hostname;

    const image = new ImageResponse(
      <div
        style={{
          width: "1200px",
          height: "630px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px",
          backgroundColor: "#0a0a0a",
          color: "#f5f5f5",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <div
            style={{
              fontSize: 30,
              letterSpacing: 6,
              textTransform: "uppercase",
              fontWeight: 700,
            }}
          >
            RoastMyLP
          </div>
          <div style={{ fontSize: 28, color: "#8a8a8a" }}>CRO Scorecard</div>
        </div>

        <div style={{ display: "flex", alignItems: "flex-end", gap: 48 }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 220, lineHeight: 1, fontWeight: 900 }}>
              {parsed.data.score}
              <span style={{ fontSize: 72, color: "#8a8a8a" }}>/100</span>
            </div>
            <div style={{ fontSize: 56, fontWeight: 800, marginTop: 16 }}>
              Verdict: {parsed.data.verdict}
            </div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
          }}
        >
          <div style={{ fontSize: 40, fontWeight: 600 }}>{hostname}</div>
          <div style={{ fontSize: 26, color: "#dfff00" }}>
            Roast your landing page → roastmylp
          </div>
        </div>
      </div>,
      { width: 1200, height: 630 },
    );

    // Private render: never cached by shared caches or scrapers.
    image.headers.set("cache-control", "private, no-store");
    return image;
  } catch {
    return new Response("Not found", { status: 404 });
  } finally {
    await database.close();
  }
}

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { createDatabase } from "../../../db/client";
import { DrizzleReportRepository } from "../../../db/report-repository";
import { PRODUCT_NAME } from "../../../lib/product";
import { isValidViewKeyFormat } from "../../../lib/view-key";
import { createScorecardToken } from "../../../lib/scorecard-token";
import { ReportView } from "../../../components/report-view";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Your private Roast report — ${PRODUCT_NAME}`,
  robots: { index: false, follow: false },
  other: { referrer: "no-referrer" },
};

async function resolveAccess(token: string) {
  if (!isValidViewKeyFormat(token)) return undefined;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return undefined;

  const database = createDatabase(databaseUrl);
  try {
    return await new DrizzleReportRepository(database.db).resolveReportAccess(
      token,
    );
  } catch {
    return undefined;
  } finally {
    await database.close();
  }
}

/**
 * POR-22/23: the private capability-link report. The view key in the path is
 * the only credential; anything else renders the same non-disclosing 404.
 */
export default async function ReportPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const access = await resolveAccess(token);
  if (!access) notFound();

  const hmacKey = process.env.ABUSE_SIGNAL_HMAC_KEY;
  const scorecardPath = hmacKey
    ? `/api/scorecard/${createScorecardToken(hmacKey, access.roastId)}`
    : undefined;

  return (
    <main className="bg-ink text-paper min-h-screen">
      <header className="border-rule border-b">
        <div className="page-shell flex min-h-14 items-center justify-between gap-4 py-3 font-mono text-[0.68rem] tracking-[0.16em] uppercase sm:text-xs">
          <Link href="/" className="focus-ring text-paper font-bold">
            {PRODUCT_NAME}
          </Link>
          <p className="text-muted">Private report · do not share</p>
        </div>
      </header>
      <ReportView
        hostname={access.hostname}
        report={access.report}
        model={access.model}
        scorecardPath={scorecardPath}
      />
      <footer className="border-rule page-shell text-muted border-t py-8 font-mono text-[0.68rem] tracking-[0.12em] uppercase">
        <Link href="/" className="focus-ring text-signal">
          Roast another landing page →
        </Link>
      </footer>
    </main>
  );
}

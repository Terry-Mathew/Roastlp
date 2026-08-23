import { createAuditJobRoute } from "./route-handler";
import { createAuditPipeline } from "../../../../lib/audit-pipeline";
import { ScreenshotCapture } from "../../../../lib/screenshot-capture";
import { OpenAIVisionAnalyzer } from "../../../../lib/openai-vision";
import { DrizzleReportRepository } from "../../../../db/report-repository";
import { hashReportAccessToken } from "../../../../db/report-token";
import { deriveReportViewKey } from "../../../../lib/view-key";
import { EmailSender } from "../../../../lib/email-service";
import { createResendClient } from "../../../../lib/resend-client";
import { DrizzleRefundRepository } from "../../../../db/refund-repository";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Real pipeline composition: capture (ScreenshotOne) -> analyze (OpenAI
 * vision, strict structured output) -> persist (one report row) -> complete
 * (roast completed + capability grant bound to the derived view key) ->
 * deliver (POR-25 transactional result email with the private link).
 *
 * Active only when every provider credential is present. Otherwise the route
 * keeps its 503-before-leasing posture so QStash retries and the reconciler
 * keep paid audits recoverable without burning attempt budgets.
 */
function buildRoute() {
  const databaseUrl = process.env.DATABASE_URL;
  const screenshotKey = process.env.SCREENSHOTONE_ACCESS_KEY;
  const openAiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  const hmacKey = process.env.ABUSE_SIGNAL_HMAC_KEY;
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (
    !databaseUrl ||
    !screenshotKey ||
    !openAiKey ||
    !model ||
    !hmacKey ||
    !currentSigningKey ||
    !nextSigningKey
  )
    return createAuditJobRoute(null);

  return createAuditJobRoute(
    (db) => {
      const reports = new DrizzleReportRepository(db);
      return createAuditPipeline({
        db,
        capture: new ScreenshotCapture(screenshotKey),
        analyzer: new OpenAIVisionAnalyzer(openAiKey, model),
        model,
        onReportPersisted: async (roastId) => {
          await reports.markRoastCompleted(roastId);
          await reports.ensureGrantForViewHash(
            roastId,
            hashReportAccessToken(deriveReportViewKey(hmacKey, roastId)),
          );
        },
      });
    },
    process.env,
    {
      onJobSucceeded: async (db, jobId) => {
        const resendApiKey = process.env.RESEND_API_KEY;
        const resendFromEmail = process.env.RESEND_FROM_EMAIL;
        const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
        // Email is best-effort at this boundary: a missing credential or a
        // failed send leaves a pending ledger row for the recovery sweep.
        if (!resendApiKey || !resendFromEmail || !appUrl || !hmacKey) return;

        const roastId = await new DrizzleRefundRepository(db).roastIdForJob(
          jobId,
        );
        if (!roastId) return;
        await new EmailSender(db, createResendClient(resendApiKey), {
          fromEmail: resendFromEmail,
          appUrl,
          serviceContact: "support@roastmylp.app",
        }).sendResultEmail({
          roastId,
          viewKey: deriveReportViewKey(hmacKey, roastId),
        });
      },
    },
  );
}

export const POST = buildRoute();

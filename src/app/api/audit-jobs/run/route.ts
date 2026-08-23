import { createAuditJobRoute } from "./route-handler";
import { createAuditPipeline } from "../../../../lib/audit-pipeline";
import { ScreenshotCapture } from "../../../../lib/screenshot-capture";
import { OpenAIVisionAnalyzer } from "../../../../lib/openai-vision";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Real pipeline composition: capture (ScreenshotOne) -> analyze (OpenAI
 * vision, strict structured output) -> persist (one report row).
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
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (
    !databaseUrl ||
    !screenshotKey ||
    !openAiKey ||
    !model ||
    !currentSigningKey ||
    !nextSigningKey
  )
    return createAuditJobRoute(null);

  return createAuditJobRoute((db) =>
    createAuditPipeline({
      db,
      capture: new ScreenshotCapture(screenshotKey),
      analyzer: new OpenAIVisionAnalyzer(openAiKey, model),
      model,
    }),
  );
}

export const POST = buildRoute();

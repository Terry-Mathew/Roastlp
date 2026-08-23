import { createHash } from "node:crypto";

import { ScreenshotCapture } from "./screenshot-capture";
import { VisionAnalysisError, type VisionAnalyzer } from "./openai-vision";
import { withVerdict } from "./roast-schema";
import { DrizzleReportRepository } from "../db/report-repository";
import type { Database } from "../db/client";
import type { AuditPipeline } from "./job-service";

export interface AuditPipelineDeps {
  db: Database;
  capture: Pick<ScreenshotCapture, "capture">;
  analyzer: VisionAnalyzer;
  model: string;
  /** Injectable for tests; defaults to the Drizzle-backed store. */
  reports?: Pick<DrizzleReportRepository, "saveReport">;
}

/**
 * Composes the audit stages behind POR-17's pipeline seam:
 * capture (ScreenshotOne, transient binary) -> analyze (OpenAI vision,
 * strict structured output) -> persist (single report row).
 *
 * The screenshot exists only in memory for the duration of this function.
 */
export function createAuditPipeline(deps: AuditPipelineDeps): AuditPipeline {
  const reports = deps.reports ?? new DrizzleReportRepository(deps.db);

  return async (input) => {
    let screenshot: Buffer;
    try {
      const captured = await deps.capture.capture(input.canonicalUrl);
      screenshot = captured.bytes;
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        // Capture failures are terminal only when the target itself is
        // unusable (blank/challenge/oversized); transport issues stay retryable.
        const code = String(error.code);
        const terminalCodes = new Set([
          "BLANK_PAGE",
          "NON_IMAGE_RESPONSE",
          "OVERSIZED_PAGE",
          "INVALID_CANONICAL_URL",
        ]);
        return {
          classification: terminalCodes.has(code)
            ? "terminal_failure"
            : "retryable_failure",
          errorCode: `CAPTURE_${code}`,
        };
      }
      throw error;
    }

    const host = hostOf(input.canonicalUrl);
    try {
      const roast = await deps.analyzer.analyze({
        screenshotPng: screenshot,
        canonicalHost: host,
      });
      const stored = withVerdict(roast);
      await reports.saveReport(
        input.roastId,
        stored as unknown as Record<string, unknown>,
        deps.model,
      );
      return { classification: "succeeded" };
    } catch (error) {
      if (error instanceof VisionAnalysisError) {
        return {
          classification: error.classification,
          errorCode: error.code,
        };
      }
      throw error;
    }
  };
}

function hostOf(canonicalUrl: string): string {
  try {
    return new URL(canonicalUrl).hostname;
  } catch {
    return "";
  }
}

/** Exposed for tests and operational debugging; never logged. */
export function screenshotFingerprint(screenshot: Buffer): string {
  return createHash("sha256").update(screenshot).digest("hex");
}

import { createAuditJobRoute } from "./route-handler";

/**
 * Default pipeline placeholder: every delivery is classified transient so
 * paid audits remain recoverable until the capture/analyze composition
 * (POR-19) is wired in. QStash retries plus the reconciler will keep
 * re-attempting; nothing terminal-fails from this stub alone.
 */
async function pendingPipeline() {
  return {
    classification: "retryable_failure" as const,
    errorCode: "PIPELINE_NOT_CONFIGURED",
  };
}

export const POST = createAuditJobRoute(pendingPipeline);

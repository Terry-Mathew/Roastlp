/**
 * POR-25: minimal Resend send client. Transport-only; the EmailSender owns
 * templates, idempotency and the durable delivery ledger.
 *
 * Error classification mirrors razorpay-refunds.ts:
 * - 4xx (except 429) -> ResendRejectedError, never retried
 * - 429 / 5xx / network -> ResendUnavailableError, safe to retry later
 */
const RESEND_API_BASE = "https://api.resend.com";
const SEND_TIMEOUT_MS = 10_000;

export interface ResendSendResult {
  /** Provider message id (e.g. "4ef9b4ca-..."); unique in our ledger. */
  id: string;
}

export class ResendRejectedError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
  ) {
    super(`Resend rejected send (${status})`);
    this.name = "ResendRejectedError";
  }
}

export class ResendUnavailableError extends Error {
  constructor(readonly detail: string) {
    super("Resend unavailable");
    this.name = "ResendUnavailableError";
  }
}

/** Structural sender seam so tests never touch the network. */
export interface ResendApiClient {
  send(input: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
    headers: Record<string, string>;
  }): Promise<ResendSendResult>;
}

export function createResendClient(apiKey: string): ResendApiClient {
  return {
    async send(input): Promise<ResendSendResult> {
      let response: Response;
      try {
        response = await fetch(`${RESEND_API_BASE}/emails`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch (error) {
        throw new ResendUnavailableError(String(error));
      }

      const raw = await response.text();
      if (!response.ok) {
        if (response.status === 429 || response.status >= 500)
          throw new ResendUnavailableError(`HTTP_${response.status}`);
        // Map provider rejections to a bounded error code for the ledger;
        // the response body is deliberately not persisted or logged.
        const code =
          response.status === 422
            ? "RESEND_INVALID_RECIPIENT"
            : `RESEND_REJECTED_${response.status}`;
        throw new ResendRejectedError(response.status, code);
      }
      try {
        const parsed = JSON.parse(raw) as { id?: unknown };
        if (typeof parsed.id !== "string" || parsed.id.length === 0)
          throw new ResendUnavailableError("MISSING_MESSAGE_ID");
        return { id: parsed.id };
      } catch (error) {
        if (error instanceof ResendUnavailableError) throw error;
        throw new ResendUnavailableError("UNPARSEABLE_RESPONSE");
      }
    },
  };
}

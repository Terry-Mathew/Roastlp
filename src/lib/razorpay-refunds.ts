import { z } from "zod";

const refundResponseSchema = z
  .object({
    id: z
      .string()
      .regex(/^rfnd_[A-Za-z0-9]+$/)
      .max(64),
    entity: z.literal("refund"),
    payment_id: z
      .string()
      .regex(/^pay_[A-Za-z0-9]+$/)
      .max(64),
    amount: z.number().int().positive(),
    status: z.enum(["pending", "processed", "failed"]),
    speed_requested: z.enum(["normal", "optimum"]).optional(),
  })
  .passthrough();

export type RazorpayRefund = z.infer<typeof refundResponseSchema>;

/**
 * Razorpay requires >=10 chars of [A-Za-z0-9_-] and byte-identical retries.
 * We derive it deterministically from our payment UUID so every retry path
 * converges on the same key.
 */
export function buildRefundIdempotencyKey(paymentId: string): string {
  return `rfnd-${paymentId}`;
}

export function isValidRefundIdempotencyKey(key: string): boolean {
  return /^[A-Za-z0-9_-]{10,128}$/.test(key);
}

export class RefundConflictError extends Error {
  constructor() {
    super("Razorpay refund is still processing a prior identical request");
    this.name = "RefundConflictError";
  }
}

export class RefundRejectedError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RefundRejectedError";
  }
}

export class RefundUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RefundUnavailableError";
  }
}

export interface RefundApiClient {
  create(input: {
    razorpayPaymentId: string;
    amountPaise: number;
    idempotencyKey: string;
  }): Promise<RazorpayRefund>;
  fetch(refundId: string): Promise<RazorpayRefund>;
}

export class RazorpayRefundApi implements RefundApiClient {
  constructor(
    private keyId: string,
    private keySecret: string,
    private fetcher: typeof fetch = fetch,
  ) {}

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64")}`;
  }

  private async parse(response: Response): Promise<RazorpayRefund> {
    if (
      response.headers.get("content-type")?.split(";", 1)[0] !==
      "application/json"
    )
      throw new RefundUnavailableError(
        "Razorpay refund returned a non-JSON response",
      );
    const text = await response.text();
    if (Buffer.byteLength(text) > 65_536)
      throw new RefundUnavailableError(
        "Razorpay refund response was too large",
      );
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new RefundUnavailableError("Razorpay refund returned invalid JSON");
    }
    return refundResponseSchema.parse(raw);
  }

  async create(input: {
    razorpayPaymentId: string;
    amountPaise: number;
    idempotencyKey: string;
  }): Promise<RazorpayRefund> {
    if (!isValidRefundIdempotencyKey(input.idempotencyKey))
      throw new RefundRejectedError(
        400,
        "Refund idempotency key does not satisfy Razorpay constraints",
      );

    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.razorpay.com/v1/payments/${input.razorpayPaymentId}/refund`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: this.authHeader(),
            // Normal speed (5–7 working days): cost-controlled default.
            "X-Refund-Idempotency": input.idempotencyKey,
          },
          body: JSON.stringify({ amount: input.amountPaise }),
          cache: "no-store",
          signal: AbortSignal.timeout(5_000),
        },
      );
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError")
        throw new RefundUnavailableError("Razorpay refund timed out");
      throw new RefundUnavailableError("Razorpay refund request failed", {
        cause: error,
      });
    }

    if (response.status === 409) throw new RefundConflictError();
    if (!response.ok) {
      const message = `Razorpay refund request failed (${response.status})`;
      if (response.status >= 500) throw new RefundUnavailableError(message);
      throw new RefundRejectedError(response.status, message);
    }
    return this.parse(response);
  }

  async fetch(refundId: string): Promise<RazorpayRefund> {
    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.razorpay.com/v1/refunds/${encodeURIComponent(refundId)}`,
        {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: this.authHeader(),
          },
          cache: "no-store",
          signal: AbortSignal.timeout(5_000),
        },
      );
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError")
        throw new RefundUnavailableError("Razorpay refund lookup timed out");
      throw new RefundUnavailableError("Razorpay refund lookup failed", {
        cause: error,
      });
    }
    if (!response.ok) {
      const message = `Razorpay refund lookup failed (${response.status})`;
      if (response.status >= 500) throw new RefundUnavailableError(message);
      throw new RefundRejectedError(response.status, message);
    }
    return this.parse(response);
  }
}

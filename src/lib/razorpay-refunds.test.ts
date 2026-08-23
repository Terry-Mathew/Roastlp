import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RazorpayRefundApi,
  RefundConflictError,
  RefundUnavailableError,
  buildRefundIdempotencyKey,
  isValidRefundIdempotencyKey,
} from "./razorpay-refunds";

const KEY_ID = "rzp_test_id";
const KEY_SECRET = "rzp_secret_value";
const PAYMENT_ID = "pay_ABCDEF123456";

function refundPayload(status: string) {
  return {
    id: "rfnd_ABCDEF123456",
    entity: "refund",
    payment_id: PAYMENT_ID,
    amount: 19_900,
    currency: "INR",
    status,
    speed_requested: "normal",
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("POR-18 Razorpay refund contract", () => {
  it("sends the idempotency key header, normal-speed full-amount body and basic auth", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(refundPayload("pending")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const api = new RazorpayRefundApi(
      KEY_ID,
      KEY_SECRET,
      fetchMock as unknown as typeof fetch,
    );

    const result = await api.create({
      razorpayPaymentId: PAYMENT_ID,
      amountPaise: 19_900,
      idempotencyKey: "rfnd-0b8f6c1e-1234-4cde-9abc-000000000000",
    });

    expect(result.id).toBe("rfnd_ABCDEF123456");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      `https://api.razorpay.com/v1/payments/${PAYMENT_ID}/refund`,
    );
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Refund-Idempotency"]).toBe(
      "rfnd-0b8f6c1e-1234-4cde-9abc-000000000000",
    );
    expect(headers.authorization).toMatch(/^Basic /);
    expect(JSON.parse(String(init.body))).toEqual({ amount: 19_900 });
  });

  it("derives a deterministic, constraint-satisfying idempotency key", () => {
    const key = buildRefundIdempotencyKey(
      "0b8f6c1e-1234-4cde-9abc-000000000000",
    );
    expect(isValidRefundIdempotencyKey(key)).toBe(true);
    expect(key).toBe(
      buildRefundIdempotencyKey("0b8f6c1e-1234-4cde-9abc-000000000000"),
    );
    expect(isValidRefundIdempotencyKey("short")).toBe(false);
  });

  it("maps 409 conflicts separately from definitive rejections and outages", async () => {
    const conflictApi = new RazorpayRefundApi(
      KEY_ID,
      KEY_SECRET,
      (async () =>
        new Response("", { status: 409 })) as unknown as typeof fetch,
    );
    await expect(
      conflictApi.create({
        razorpayPaymentId: PAYMENT_ID,
        amountPaise: 19_900,
        idempotencyKey: "rfnd-conflict-key-ok",
      }),
    ).rejects.toBeInstanceOf(RefundConflictError);

    const rejectedApi = new RazorpayRefundApi(
      KEY_ID,
      KEY_SECRET,
      (async () =>
        new Response("", { status: 400 })) as unknown as typeof fetch,
    );
    await expect(
      rejectedApi.create({
        razorpayPaymentId: PAYMENT_ID,
        amountPaise: 19_900,
        idempotencyKey: "rfnd-rejected-key-ok",
      }),
    ).rejects.toMatchObject({ status: 400 });

    const downApi = new RazorpayRefundApi(
      KEY_ID,
      KEY_SECRET,
      (async () =>
        new Response("", { status: 503 })) as unknown as typeof fetch,
    );
    await expect(
      downApi.create({
        razorpayPaymentId: PAYMENT_ID,
        amountPaise: 19_900,
        idempotencyKey: "rfnd-downkey-ok",
      }),
    ).rejects.toBeInstanceOf(RefundUnavailableError);
  });

  it("classifies timeouts as retryable unavailability", async () => {
    const api = new RazorpayRefundApi(KEY_ID, KEY_SECRET, (async () => {
      const error = new Error("aborted");
      error.name = "TimeoutError";
      throw error;
    }) as unknown as typeof fetch);
    await expect(api.fetch("rfnd_ABCDEF123456")).rejects.toBeInstanceOf(
      RefundUnavailableError,
    );
  });
});

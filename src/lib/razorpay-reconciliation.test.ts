import { describe, expect, it, vi } from "vitest";
import { RazorpayReconciliationApi } from "./razorpay-reconciliation";

function json(body: object, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("POR-15 Razorpay reconciliation API", () => {
  it("uses server credentials and validates payment evidence", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        id: "pay_por15Payment1",
        entity: "payment",
        amount: 19_900,
        amount_captured: 19_900,
        currency: "INR",
        status: "captured",
        order_id: "order_por15Order1",
        captured: true,
        email: "not-returned-by-adapter@example.com",
      }),
    );
    const result = await new RazorpayReconciliationApi(
      "rzp_test_public",
      "private-test-secret",
      fetcher,
    ).fetchPayment("pay_por15Payment1");
    expect(result.status).toBe("captured");
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.razorpay.com/v1/payments/pay_por15Payment1",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
    const headers = fetcher.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from("rzp_test_public:private-test-secret").toString("base64")}`,
    );
  });

  it("rejects non-JSON, oversized, failed, and malformed responses", async () => {
    const nonJson = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    await expect(
      new RazorpayReconciliationApi("id", "secret", nonJson).fetchPayment(
        "pay_por15Payment1",
      ),
    ).rejects.toThrow(/non-JSON/);

    const failed = vi.fn<typeof fetch>().mockResolvedValue(json({}, 500));
    await expect(
      new RazorpayReconciliationApi("id", "secret", failed).fetchOrder(
        "order_por15Order1",
      ),
    ).rejects.toThrow(/failed \(500\)/);

    const oversized = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(`{"padding":"${"x".repeat(70_000)}"}`, {
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      new RazorpayReconciliationApi("id", "secret", oversized).fetchOrder(
        "order_por15Order1",
      ),
    ).rejects.toThrow(/too large/);

    const malformed = vi.fn<typeof fetch>().mockResolvedValue(json({ id: 1 }));
    await expect(
      new RazorpayReconciliationApi("id", "secret", malformed).fetchPayment(
        "pay_por15Payment1",
      ),
    ).rejects.toThrow();
  });
});

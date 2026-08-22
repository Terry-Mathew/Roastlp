import { afterEach, describe, expect, it, vi } from "vitest";
import { RazorpayOrders } from "./razorpay-orders";

afterEach(() => vi.unstubAllGlobals());

describe("POR-13 Razorpay order contract", () => {
  it("sends only the server-owned ₹199 order contract and accepts a matching response", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          id: "order_secure123",
          entity: "order",
          amount: 19_900,
          amount_paid: 0,
          amount_due: 19_900,
          currency: "INR",
          receipt: body.receipt,
          status: "created",
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await new RazorpayOrders(
      "rzp_test_public",
      "private-secret",
    ).create("r_secure", "roast-opaque");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init.body))).toEqual({
      amount: 19_900,
      currency: "INR",
      receipt: "r_secure",
      partial_payment: false,
      notes: { roast_ref: "roast-opaque" },
    });
    expect(result.id).toBe("order_secure123");
    expect(JSON.stringify(result)).not.toContain("private-secret");
  });

  it("rejects provider responses with a changed amount or receipt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: "order_bad",
              entity: "order",
              amount: 1,
              amount_paid: 0,
              amount_due: 1,
              currency: "INR",
              receipt: "wrong",
              status: "created",
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(
      new RazorpayOrders("rzp_test_public", "private-secret").create(
        "r_secure",
        "roast-opaque",
      ),
    ).rejects.toThrow();
  });

  it("does not expose raw provider error bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { description: "sensitive provider detail" },
            }),
            { status: 500 },
          ),
      ),
    );
    await expect(
      new RazorpayOrders("rzp_test_public", "private-secret").create(
        "r_secure",
        "roast-opaque",
      ),
    ).rejects.toThrow("Razorpay order request failed (500)");
  });
});

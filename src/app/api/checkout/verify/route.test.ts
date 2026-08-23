import { afterEach, describe, expect, it } from "vitest";
import { POST } from "./route";

describe("POR-14 payment verification HTTP boundary", () => {
  const previous = process.env.CHECKOUT_ENABLED;
  afterEach(() => {
    if (previous === undefined) delete process.env.CHECKOUT_ENABLED;
    else process.env.CHECKOUT_ENABLED = previous;
  });

  it("rejects non-JSON and oversized requests before dependencies", async () => {
    expect(
      (
        await POST(
          new Request("http://localhost/api/checkout/verify", {
            method: "POST",
            body: "x",
          }),
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await POST(
          new Request("http://localhost/api/checkout/verify", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": "2000",
            },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(413);
  });

  it("fails closed without revealing configuration details", async () => {
    process.env.CHECKOUT_ENABLED = "false";
    const response = await POST(
      new Request("http://localhost/api/checkout/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "PAYMENT_VERIFICATION_UNAVAILABLE",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

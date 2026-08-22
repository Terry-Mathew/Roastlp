import { afterEach, describe, expect, it } from "vitest";
import { POST } from "./route";

describe("POR-13 checkout HTTP boundary", () => {
  const previous = process.env.CHECKOUT_ENABLED;
  afterEach(() => {
    if (previous === undefined) delete process.env.CHECKOUT_ENABLED;
    else process.env.CHECKOUT_ENABLED = previous;
  });

  it("rejects non-JSON and oversized requests before dependencies", async () => {
    expect(
      (
        await POST(
          new Request("http://localhost/api/checkout", {
            method: "POST",
            body: "x",
          }),
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await POST(
          new Request("http://localhost/api/checkout", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": "5000",
            },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(413);
  });

  it("fails closed with a generic response while live checkout is disabled", async () => {
    process.env.CHECKOUT_ENABLED = "false";
    const response = await POST(
      new Request("http://localhost/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "CHECKOUT_UNAVAILABLE" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

import { describe, expect, it } from "vitest";

import { PRODUCT_NAME, ROAST_PRICE_INR } from "./product";

describe("Phase 1 product contract", () => {
  it("keeps the paid Roast identity and server-owned price explicit", () => {
    expect(PRODUCT_NAME).toBe("RoastMyLP");
    expect(ROAST_PRICE_INR).toBe(199);
  });
});

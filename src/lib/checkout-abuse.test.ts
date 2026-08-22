import { describe, expect, it } from "vitest";
import { keyedDigest } from "./checkout-crypto";
import { trustedVercelIp } from "./checkout-abuse";

describe("POR-13 privacy-preserving abuse signals", () => {
  it("trusts only one valid IP supplied through Vercel ingress", () => {
    expect(
      trustedVercelIp(
        new Headers({ "x-vercel-forwarded-for": "203.0.113.8" }),
        true,
      ),
    ).toBe("203.0.113.8");
    expect(
      trustedVercelIp(
        new Headers({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" }),
        true,
      ),
    ).toBeUndefined();
    expect(
      trustedVercelIp(
        new Headers({ "x-vercel-forwarded-for": "203.0.113.8" }),
        false,
      ),
    ).toBeUndefined();
  });

  it("uses purpose-separated non-reversible identifiers", () => {
    const secret = "a-secure-test-key-with-at-least-thirty-two-bytes";
    const ip = keyedDigest(secret, "checkout-ip-v1", "203.0.113.8");
    const domain = keyedDigest(secret, "checkout-domain-v1", "203.0.113.8");
    expect(ip).toMatch(/^[0-9a-f]{64}$/);
    expect(domain).not.toBe(ip);
    expect(ip).not.toContain("203.0.113.8");
  });
});

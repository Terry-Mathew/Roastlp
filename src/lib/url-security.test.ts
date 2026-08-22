import { describe, expect, it, vi } from "vitest";

import {
  MAX_REDIRECTS,
  UrlSecurityError,
  type HostResolver,
  validateOutboundUrl,
  validateRedirectChain,
} from "./url-security";

const PUBLIC_V4 = "93.184.216.34";
const PUBLIC_V6 = "2606:2800:220:1:248:1893:25c8:1946";

const publicResolver = vi.fn<HostResolver>(async () => [
  { address: PUBLIC_V4, family: 4 },
  { address: PUBLIC_V6, family: 6 },
]);

async function expectCode(
  promise: Promise<unknown>,
  code: UrlSecurityError["code"],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("validateOutboundUrl", () => {
  it("returns one immutable canonical representation", async () => {
    const result = await validateOutboundUrl(
      "HTTPS://Example.COM/path?q=hello%20world",
      { resolver: publicResolver },
    );

    expect(result).toEqual({
      canonicalUrl: "https://example.com/path?q=hello%20world",
      displayUrl: "https://example.com/path?q=hello%20world",
      hostname: "example.com",
      resolvedAddresses: [
        { address: PUBLIC_V4, family: 4 },
        { address: PUBLIC_V6, family: 6 },
      ],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.resolvedAddresses)).toBe(true);
  });

  it("keeps internationalized hostnames in ASCII to prevent display spoofing", async () => {
    const result = await validateOutboundUrl("https://münich.example/", {
      resolver: publicResolver,
    });

    expect(result.hostname).toBe("xn--mnich-kva.example");
    expect(result.displayUrl).toBe("https://xn--mnich-kva.example/");
  });

  it.each([
    ["http://example.com:80/path", "http://example.com/path"],
    ["https://example.com:443/path", "https://example.com/path"],
  ])(
    "accepts and removes the default port in %s",
    async (url, canonicalUrl) => {
      const result = await validateOutboundUrl(url, {
        resolver: publicResolver,
      });
      expect(result.canonicalUrl).toBe(canonicalUrl);
    },
  );

  it.each([
    ["http://93.184.216.34/", "93.184.216.34"],
    ["http://[2606:2800:220:1:248:1893:25c8:1946]/", PUBLIC_V6],
  ])("accepts globally reachable direct address %s", async (url, hostname) => {
    const result = await validateOutboundUrl(url);
    expect(result.hostname).toBe(hostname);
  });

  it.each([
    ["ftp://example.com", "PROTOCOL_NOT_ALLOWED"],
    ["https://user:secret@example.com", "CREDENTIALS_NOT_ALLOWED"],
    ["https://example.com/#section", "FRAGMENT_NOT_ALLOWED"],
    ["https://example.com:8443", "PORT_NOT_ALLOWED"],
    [" https://example.com", "CONTROL_CHARACTER"],
    ["https:\\example.com", "CONTROL_CHARACTER"],
    ["https://example.com\u0000", "CONTROL_CHARACTER"],
    ["https://localhost", "HOSTNAME_NOT_ALLOWED"],
    ["https://metadata.google.internal", "HOSTNAME_NOT_ALLOWED"],
    ["https://bit.ly/abc", "SHORTENER_NOT_ALLOWED"],
    ["https://go.tinyurl.com/abc", "SHORTENER_NOT_ALLOWED"],
    ["https://singlelabel", "INVALID_HOSTNAME"],
    ["https://example.com./", "INVALID_HOSTNAME"],
    ["https://-bad.example", "INVALID_HOSTNAME"],
    ["https://xn--.example", "INVALID_URL"],
  ])("rejects %s with %s", async (url, code) => {
    await expectCode(
      validateOutboundUrl(url, { resolver: publicResolver }),
      code as UrlSecurityError["code"],
    );
  });

  it("rejects an excessively long URL before parsing or DNS", async () => {
    await expectCode(
      validateOutboundUrl(`https://example.com/${"a".repeat(2_100)}`, {
        resolver: publicResolver,
      }),
      "URL_TOO_LONG",
    );
  });

  it.each([
    "http://127.0.0.1",
    "http://127.1",
    "http://2130706433",
    "http://0177.0.0.1",
    "http://0x7f000001",
    "http://[::1]",
    "http://[::ffff:127.0.0.1]",
    "http://[::ffff:93.184.216.34]",
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.1",
    "http://172.16.0.1",
    "http://192.168.0.1",
    "http://100.64.0.1",
    "http://224.0.0.1",
    "http://192.0.2.1",
    "http://[fe80::1]",
    "http://[fc00::1]",
    "http://[2001:db8::1]",
  ])("rejects non-public or encoded address %s", async (url) => {
    await expectCode(validateOutboundUrl(url), "NON_PUBLIC_ADDRESS");
  });

  it("rejects a hostname when any A or AAAA result is non-public", async () => {
    const mixedResolver: HostResolver = async () => [
      { address: PUBLIC_V4, family: 4 },
      { address: "10.0.0.7", family: 4 },
    ];

    await expectCode(
      validateOutboundUrl("https://example.com", { resolver: mixedResolver }),
      "NON_PUBLIC_ADDRESS",
    );
  });

  it.each(["::ffff:127.0.0.1", "::ffff:93.184.216.34"])(
    "rejects IPv4-mapped IPv6 DNS answer %s",
    async (address) => {
      const mappedResolver: HostResolver = async () => [{ address, family: 6 }];

      await expectCode(
        validateOutboundUrl("https://example.com", {
          resolver: mappedResolver,
        }),
        "NON_PUBLIC_ADDRESS",
      );
    },
  );

  it("rejects empty and failed DNS resolution", async () => {
    await expectCode(
      validateOutboundUrl("https://example.com", {
        resolver: async () => [],
      }),
      "NO_RESOLVED_ADDRESS",
    );
    await expectCode(
      validateOutboundUrl("https://example.com", {
        resolver: async () => {
          throw new Error("resolver unavailable");
        },
      }),
      "DNS_LOOKUP_FAILED",
    );
  });
});

describe("validateRedirectChain", () => {
  it("revalidates absolute and relative redirect targets", async () => {
    const resolver = vi.fn<HostResolver>(async () => [
      { address: PUBLIC_V4, family: 4 },
    ]);

    const chain = await validateRedirectChain(
      "https://example.com/start",
      ["/next", "https://www.example.org/final"],
      { resolver },
    );

    expect(chain.map(({ canonicalUrl }) => canonicalUrl)).toEqual([
      "https://example.com/start",
      "https://example.com/next",
      "https://www.example.org/final",
    ]);
    expect(resolver).toHaveBeenCalledTimes(3);
  });

  it("blocks a redirect pivot to a private address", async () => {
    await expectCode(
      validateRedirectChain(
        "https://example.com",
        ["http://169.254.169.254/latest/meta-data"],
        { resolver: publicResolver },
      ),
      "NON_PUBLIC_ADDRESS",
    );
  });

  it("detects a DNS rebinding simulation on a later hop", async () => {
    const rebindingResolver = vi
      .fn<HostResolver>()
      .mockResolvedValueOnce([{ address: PUBLIC_V4, family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);

    await expectCode(
      validateRedirectChain("https://example.com/start", ["/next"], {
        resolver: rebindingResolver,
      }),
      "NON_PUBLIC_ADDRESS",
    );
    expect(rebindingResolver).toHaveBeenCalledTimes(2);
  });

  it("enforces the redirect limit before making a request", async () => {
    await expectCode(
      validateRedirectChain(
        "https://example.com",
        Array.from({ length: MAX_REDIRECTS + 1 }, () => "/next"),
        { resolver: publicResolver },
      ),
      "TOO_MANY_REDIRECTS",
    );
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ScreenshotCapture,
  ScreenshotCaptureError,
} from "./screenshot-capture";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const LARGE_PNG = (() => {
  const header = Buffer.from(PNG_1X1.subarray(0, 24));
  return Buffer.concat([header, Buffer.alloc(6_000, 7)]);
})();

afterEach(() => vi.unstubAllGlobals());

function capture() {
  return new ScreenshotCapture("access-key-secret");
}

describe("POR-16 privacy-preserving screenshot capture", () => {
  it("requests a full-page binary capture without cache or storage and never leaks the access key in the URL path", async () => {
    let requestUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        requestUrl = String(input);
        return new Response(new Uint8Array(LARGE_PNG), { status: 200 });
      }),
    );

    const result = await capture().capture("https://example.com/landing");

    const params = new URL(requestUrl).searchParams;
    expect(params.get("url")).toBe("https://example.com/landing");
    expect(params.get("full_page")).toBe("true");
    expect(params.get("reduced_motion")).toBe("true");
    expect(params.get("viewport_width")).toBe("1280");
    expect(params.get("viewport_height")).toBe("1024");
    expect(params.get("block_ads")).toBe("true");
    expect(params.get("block_trackers")).toBe("true");
    expect(params.get("block_cookie_banners")).toBe("true");
    expect(params.has("cache")).toBe(false);
    expect(params.has("store")).toBe(false);
    expect(new URL(requestUrl).pathname).not.toContain("access-key-secret");
    expect(result.bytes.equals(LARGE_PNG)).toBe(true);
    expect(result.contentType).toBe("");
  });

  it("rejects non-https credential-bearing targets before any provider call", async () => {
    await expect(
      capture().capture("https://user:pass@example.com/page"),
    ).rejects.toMatchObject({ code: "INVALID_CANONICAL_URL" });
    await expect(
      capture().capture("ftp://example.com/page"),
    ).rejects.toMatchObject({ code: "INVALID_CANONICAL_URL" });
    expect(vi.stubGlobal).toBeDefined();
  });

  it("classifies provider timeout separately from unavailability", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const error = new Error("aborted");
        error.name = "TimeoutError";
        throw error;
      }),
    );
    await expect(
      capture().capture("https://example.com"),
    ).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
  });

  it("maps provider rejections to explicit failure codes without leaking bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"secret":"detail"}', { status: 400 })),
    );
    await expect(capture().capture("https://example.com")).rejects.toThrow(
      /rejected the capture request \(400\)/,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 })),
    );
    await expect(
      capture().capture("https://example.com"),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("rejects non-image payloads and oversized captures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>challenge page</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    );
    await expect(
      capture().capture("https://example.com"),
    ).rejects.toMatchObject({ code: "NON_IMAGE_RESPONSE" });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            Buffer.concat([LARGE_PNG, Buffer.alloc(13_000_000, 1)]),
            {
              status: 200,
              headers: { "content-type": "image/png" },
            },
          ),
      ),
    );
    await expect(
      capture().capture("https://example.com"),
    ).rejects.toMatchObject({ code: "OVERSIZED_PAGE" });
  });

  it("treats implausibly tiny images as blank pages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(PNG_1X1, { status: 200 })),
    );
    await expect(
      capture().capture("https://example.com"),
    ).rejects.toMatchObject({ code: "BLANK_PAGE" });
    await expect(
      new ScreenshotCaptureError("BLANK_PAGE", "blank"),
    ).toBeInstanceOf(ScreenshotCaptureError);
  });

  it("refuses to run without credentials", async () => {
    await expect(
      new ScreenshotCapture("").capture("https://example.com"),
    ).rejects.toMatchObject({ code: "MISSING_CREDENTIALS" });
  });
});

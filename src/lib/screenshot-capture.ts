const CAPTURE_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_BYTES = 12_000_000;
const MIN_CAPTURE_BYTES = 5_000;
const MAX_URL_LENGTH = 2_048;

const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 1024;

export type ScreenshotErrorCode =
  | "INVALID_CANONICAL_URL"
  | "MISSING_CREDENTIALS"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_REJECTED"
  | "PROVIDER_UNAVAILABLE"
  | "NON_IMAGE_RESPONSE"
  | "OVERSIZED_PAGE"
  | "BLANK_PAGE";

export class ScreenshotCaptureError extends Error {
  constructor(
    readonly code: ScreenshotErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ScreenshotCaptureError";
  }
}

export interface CapturedScreenshot {
  bytes: Buffer;
  contentType: string;
}

function httpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ScreenshotCaptureError(
      "INVALID_CANONICAL_URL",
      "Canonical target is not a parsable URL",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new ScreenshotCaptureError(
      "INVALID_CANONICAL_URL",
      "Only http and https canonical targets can be captured",
    );
  if (url.username || url.password || url.hash)
    throw new ScreenshotCaptureError(
      "INVALID_CANONICAL_URL",
      "Canonical target must not contain credentials or a fragment",
    );
  return url;
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

export class ScreenshotCapture {
  constructor(private accessKey: string) {}

  async capture(canonicalUrl: string): Promise<CapturedScreenshot> {
    if (!this.accessKey)
      throw new ScreenshotCaptureError(
        "MISSING_CREDENTIALS",
        "ScreenshotOne credentials are not configured",
      );
    const url = httpsUrl(canonicalUrl);
    if (url.toString().length > MAX_URL_LENGTH)
      throw new ScreenshotCaptureError(
        "INVALID_CANONICAL_URL",
        "Canonical target exceeds the maximum capture length",
      );

    const params = new URLSearchParams({
      access_key: this.accessKey,
      url: url.toString(),
      format: "png",
      full_page: "true",
      viewport_width: String(VIEWPORT_WIDTH),
      viewport_height: String(VIEWPORT_HEIGHT),
      reduced_motion: "true",
      block_ads: "true",
      block_trackers: "true",
      block_cookie_banners: "true",
      block_banners_by_heuristics: "true",
      delay: "3",
    });

    let response: Response;
    try {
      response = await fetch(
        `https://api.screenshotone.com/take?${params.toString()}`,
        {
          cache: "no-store",
          signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
        },
      );
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError")
        throw new ScreenshotCaptureError(
          "PROVIDER_TIMEOUT",
          "Screenshot provider did not respond in time",
        );
      throw new ScreenshotCaptureError(
        "PROVIDER_UNAVAILABLE",
        "Screenshot provider could not be reached",
        { cause: error },
      );
    }

    if (response.status === 400 || response.status === 422)
      throw new ScreenshotCaptureError(
        "PROVIDER_REJECTED",
        `Screenshot provider rejected the capture request (${response.status})`,
      );
    if (!response.ok)
      throw new ScreenshotCaptureError(
        "PROVIDER_UNAVAILABLE",
        `Screenshot provider request failed (${response.status})`,
      );

    const contentType = response.headers.get("content-type") ?? "";
    if (
      contentType &&
      !contentType.startsWith("image/") &&
      !contentType.startsWith("application/octet-stream")
    )
      throw new ScreenshotCaptureError(
        "NON_IMAGE_RESPONSE",
        "Screenshot provider returned a non-image payload",
      );

    const bytes = Buffer.from(await response.arrayBuffer());
    const isPng =
      bytes.length > 24 &&
      bytes[0] === 0x89 &&
      bytes.toString("ascii", 1, 4) === "PNG";
    if (!isPng)
      throw new ScreenshotCaptureError(
        "NON_IMAGE_RESPONSE",
        "Screenshot provider returned a payload that is not a PNG image",
      );
    if (bytes.length > MAX_CAPTURE_BYTES)
      throw new ScreenshotCaptureError(
        "OVERSIZED_PAGE",
        "Captured page exceeds the maximum accepted size",
      );
    if (bytes.length < MIN_CAPTURE_BYTES)
      throw new ScreenshotCaptureError(
        "BLANK_PAGE",
        "Captured page appears to be blank or empty",
      );

    const dimensions = pngDimensions(bytes);
    if (dimensions.width * dimensions.height === 0)
      throw new ScreenshotCaptureError(
        "BLANK_PAGE",
        "Captured image has no usable dimensions",
      );

    return { bytes, contentType };
  }
}

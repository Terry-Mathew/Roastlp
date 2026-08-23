import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const JWT_PARTS = 3;

function base64UrlDecode(part: string): Buffer {
  return Buffer.from(part, "base64url");
}

function verifyWithKey(
  token: string,
  rawBody: string,
  signingKey: string,
  expectedUrl?: string,
): boolean {
  const parts = token.split(".");
  if (parts.length !== JWT_PARTS) return false;
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [
    string,
    string,
    string,
  ];

  let header: { alg?: string };
  let claims: {
    iss?: string;
    sub?: string;
    exp?: number;
    nbf?: number;
    body?: string;
  };
  try {
    header = JSON.parse(base64UrlDecode(encodedHeader).toString());
    claims = JSON.parse(base64UrlDecode(encodedPayload).toString());
  } catch {
    return false;
  }

  if (header.alg !== "HS256") return false;

  const expected = createHmac("sha256", signingKey)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  const provided = base64UrlDecode(encodedSignature);
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  )
    return false;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (claims.iss !== "Upstash") return false;
  if (expectedUrl && claims.sub !== expectedUrl) return false;
  if (typeof claims.exp === "number" && claims.exp < nowSeconds) return false;
  if (typeof claims.nbf === "number" && claims.nbf > nowSeconds) return false;

  const bodyDigest = createHash("sha256").update(rawBody).digest("hex");
  if (!claims.body || claims.body !== bodyDigest) return false;

  return true;
}

export class QStashSignatureError extends Error {
  constructor(message = "QStash signature verification failed") {
    super(message);
    this.name = "QStashSignatureError";
  }
}

export class QStashReceiver {
  constructor(
    private currentSigningKey: string,
    private nextSigningKey: string,
  ) {}

  verify(options: { body: string; signature: string; url?: string }): void {
    const keys = [this.currentSigningKey, this.nextSigningKey].filter(
      (key) => key.length > 0,
    );
    for (const key of keys) {
      if (verifyWithKey(options.signature, options.body, key, options.url))
        return;
    }
    throw new QStashSignatureError();
  }
}

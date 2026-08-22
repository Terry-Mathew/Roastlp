import { createHmac } from "node:crypto";

export function keyedDigest(secret: string, purpose: string, value: string) {
  if (Buffer.byteLength(secret) < 32)
    throw new Error("Checkout HMAC key is too short");
  return createHmac("sha256", secret)
    .update(`${purpose}\0${value}`)
    .digest("hex");
}

export function requestFingerprint(secret: string, values: readonly string[]) {
  return keyedDigest(secret, "checkout-request-v1", JSON.stringify(values));
}

import { isIP } from "node:net";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { keyedDigest } from "./checkout-crypto";

export class RateLimitUnavailableError extends Error {}
export class CheckoutRateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("Checkout rate limit exceeded");
  }
}

export interface CheckoutLimiter {
  check(ip: string | undefined, hostname: string): Promise<void>;
}

export function trustedVercelIp(headers: Headers, isVercel: boolean) {
  if (!isVercel) return undefined;
  const value =
    headers.get("x-vercel-forwarded-for") ?? headers.get("x-forwarded-for");
  return value && !value.includes(",") && isIP(value) ? value : undefined;
}

export function createCheckoutLimiter(
  url: string,
  token: string,
  hmacKey: string,
): CheckoutLimiter {
  const redis = new Redis({ url, token });
  const common = { redis, analytics: false, timeout: 1_500 } as const;
  const ipLimiter = new Ratelimit({
    ...common,
    prefix: "rmlp:checkout:ip",
    limiter: Ratelimit.slidingWindow(5, "10 m"),
  });
  const domainLimiter = new Ratelimit({
    ...common,
    prefix: "rmlp:checkout:domain",
    limiter: Ratelimit.slidingWindow(10, "1 h"),
  });
  return {
    async check(ip, hostname) {
      try {
        const ipKey = keyedDigest(hmacKey, "checkout-ip-v1", ip ?? "missing");
        const domainKey = keyedDigest(hmacKey, "checkout-domain-v1", hostname);
        const [ipResult, domainResult] = await Promise.all([
          ipLimiter.limit(ipKey),
          domainLimiter.limit(domainKey),
        ]);
        if (ipResult.reason === "timeout" || domainResult.reason === "timeout")
          throw new RateLimitUnavailableError();
        const denied = [ipResult, domainResult].filter(
          (result) => !result.success,
        );
        if (denied.length) {
          const reset = Math.max(...denied.map((result) => result.reset));
          throw new CheckoutRateLimitedError(
            Math.max(1, Math.ceil((reset - Date.now()) / 1_000)),
          );
        }
      } catch (error) {
        if (
          error instanceof CheckoutRateLimitedError ||
          error instanceof RateLimitUnavailableError
        )
          throw error;
        throw new RateLimitUnavailableError();
      }
    },
  };
}

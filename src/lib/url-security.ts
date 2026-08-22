import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";

import ipaddr from "ipaddr.js";

const MAX_URL_LENGTH = 2_048;
export const MAX_REDIRECTS = 5;

const SHORTENER_HOSTS = new Set([
  "bit.ly",
  "buff.ly",
  "cutt.ly",
  "goo.gl",
  "is.gd",
  "ow.ly",
  "rebrand.ly",
  "shorturl.at",
  "t.co",
  "tiny.cc",
  "tinyurl.com",
  "trib.al",
  "v.gd",
]);

const METADATA_HOSTS = new Set([
  "instance-data",
  "metadata",
  "metadata.google.internal",
]);

export type UrlSecurityErrorCode =
  | "CONTROL_CHARACTER"
  | "CREDENTIALS_NOT_ALLOWED"
  | "DNS_LOOKUP_FAILED"
  | "FRAGMENT_NOT_ALLOWED"
  | "HOSTNAME_NOT_ALLOWED"
  | "INVALID_HOSTNAME"
  | "INVALID_URL"
  | "NO_RESOLVED_ADDRESS"
  | "NON_PUBLIC_ADDRESS"
  | "PORT_NOT_ALLOWED"
  | "PROTOCOL_NOT_ALLOWED"
  | "SHORTENER_NOT_ALLOWED"
  | "TOO_MANY_REDIRECTS"
  | "URL_TOO_LONG";

export class UrlSecurityError extends Error {
  constructor(
    readonly code: UrlSecurityErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UrlSecurityError";
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type HostResolver = (
  hostname: string,
) => Promise<readonly ResolvedAddress[]>;

export interface ValidatedUrl {
  canonicalUrl: string;
  displayUrl: string;
  hostname: string;
  resolvedAddresses: readonly ResolvedAddress[];
}

export interface UrlValidationOptions {
  resolver?: HostResolver;
}

const defaultResolver: HostResolver = async (hostname) => {
  const addresses = await lookup(hostname, {
    all: true,
    order: "verbatim",
  });

  return addresses.map(({ address, family }) => ({
    address,
    family: family as 4 | 6,
  }));
};

function fail(code: UrlSecurityErrorCode, message: string): never {
  throw new UrlSecurityError(code, message);
}

function withoutIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isHostOrSubdomain(hostname: string, blockedHost: string): boolean {
  return hostname === blockedHost || hostname.endsWith(`.${blockedHost}`);
}

function validateDomainName(hostname: string): string {
  if (hostname.endsWith(".")) {
    fail(
      "INVALID_HOSTNAME",
      "Fully qualified trailing-dot hostnames are not accepted",
    );
  }

  const asciiHostname = domainToASCII(hostname).toLowerCase();
  if (!asciiHostname || asciiHostname.length > 253) {
    fail(
      "INVALID_HOSTNAME",
      "The hostname is not a valid internationalized domain name",
    );
  }

  const labels = asciiHostname.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    fail("INVALID_HOSTNAME", "The hostname must be a valid public domain name");
  }

  return asciiHostname;
}

function normalizePublicAddress(
  address: string,
  expectedFamily?: 4 | 6,
): ResolvedAddress {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;

  try {
    parsed = ipaddr.parse(withoutIpv6Brackets(address));
  } catch (error) {
    throw new UrlSecurityError(
      "NON_PUBLIC_ADDRESS",
      "The hostname resolved to an invalid IP address",
      { cause: error },
    );
  }

  if (parsed.kind() === "ipv6") {
    const ipv6Address = parsed as ipaddr.IPv6;
    if (ipv6Address.isIPv4MappedAddress()) {
      fail("NON_PUBLIC_ADDRESS", "IPv4-mapped IPv6 addresses are not accepted");
    }
  }

  const family = parsed.kind() === "ipv4" ? 4 : 6;
  if (expectedFamily && family !== expectedFamily) {
    fail(
      "NON_PUBLIC_ADDRESS",
      "The DNS address family did not match its address",
    );
  }

  if (parsed.range() !== "unicast") {
    fail(
      "NON_PUBLIC_ADDRESS",
      "Only globally reachable IP addresses are accepted",
    );
  }

  return Object.freeze({ address: parsed.toString(), family });
}

function validateBlockedHostname(hostname: string): void {
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    [...METADATA_HOSTS].some((host) => isHostOrSubdomain(hostname, host))
  ) {
    fail(
      "HOSTNAME_NOT_ALLOWED",
      "Local and metadata hostnames are not accepted",
    );
  }

  if ([...SHORTENER_HOSTS].some((host) => isHostOrSubdomain(hostname, host))) {
    fail("SHORTENER_NOT_ALLOWED", "URL shorteners are not accepted");
  }
}

export async function validateOutboundUrl(
  submittedUrl: string,
  options: UrlValidationOptions = {},
): Promise<ValidatedUrl> {
  if (submittedUrl.length > MAX_URL_LENGTH) {
    fail("URL_TOO_LONG", "The URL is too long");
  }

  if (
    submittedUrl !== submittedUrl.trim() ||
    /[\\\u0000-\u001f\u007f]/.test(submittedUrl)
  ) {
    fail(
      "CONTROL_CHARACTER",
      "Whitespace, backslashes, and control characters are not accepted",
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(submittedUrl);
  } catch (error) {
    throw new UrlSecurityError("INVALID_URL", "The URL is malformed", {
      cause: error,
    });
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    fail("PROTOCOL_NOT_ALLOWED", "Only HTTP and HTTPS URLs are accepted");
  }
  if (parsedUrl.username || parsedUrl.password) {
    fail("CREDENTIALS_NOT_ALLOWED", "Credentials in URLs are not accepted");
  }
  if (parsedUrl.hash) {
    fail("FRAGMENT_NOT_ALLOWED", "URL fragments are not accepted");
  }
  if (parsedUrl.port) {
    fail(
      "PORT_NOT_ALLOWED",
      "Only the default HTTP and HTTPS ports are accepted",
    );
  }

  const parsedHostname = withoutIpv6Brackets(parsedUrl.hostname).toLowerCase();
  if (!parsedHostname) {
    fail("INVALID_HOSTNAME", "The URL must contain a hostname");
  }

  validateBlockedHostname(parsedHostname);

  let hostname: string;
  let resolvedAddresses: readonly ResolvedAddress[];
  const directIpFamily = isIP(parsedHostname);

  if (directIpFamily) {
    const address = normalizePublicAddress(
      parsedHostname,
      directIpFamily as 4 | 6,
    );
    hostname = address.address;
    resolvedAddresses = Object.freeze([address]);
    parsedUrl.hostname =
      address.family === 6 ? `[${address.address}]` : address.address;
  } else {
    hostname = validateDomainName(parsedHostname);
    validateBlockedHostname(hostname);
    parsedUrl.hostname = hostname;

    let addresses: readonly ResolvedAddress[];
    try {
      addresses = await (options.resolver ?? defaultResolver)(hostname);
    } catch (error) {
      if (error instanceof UrlSecurityError) throw error;
      throw new UrlSecurityError(
        "DNS_LOOKUP_FAILED",
        "The hostname could not be resolved",
        {
          cause: error,
        },
      );
    }

    if (addresses.length === 0) {
      fail("NO_RESOLVED_ADDRESS", "The hostname did not resolve to an address");
    }

    resolvedAddresses = Object.freeze(
      addresses.map(({ address, family }) =>
        normalizePublicAddress(address, family),
      ),
    );
  }

  const canonicalUrl = parsedUrl.toString();
  return Object.freeze({
    canonicalUrl,
    displayUrl: canonicalUrl,
    hostname,
    resolvedAddresses,
  });
}

export async function validateRedirectChain(
  submittedUrl: string,
  locations: readonly string[],
  options: UrlValidationOptions = {},
): Promise<readonly ValidatedUrl[]> {
  if (locations.length > MAX_REDIRECTS) {
    fail(
      "TOO_MANY_REDIRECTS",
      `No more than ${MAX_REDIRECTS} redirects are accepted`,
    );
  }

  const validated: ValidatedUrl[] = [];
  let current = await validateOutboundUrl(submittedUrl, options);
  validated.push(current);

  for (const location of locations) {
    let redirectUrl: string;
    try {
      redirectUrl = new URL(location, current.canonicalUrl).toString();
    } catch (error) {
      throw new UrlSecurityError(
        "INVALID_URL",
        "A redirect target is malformed",
        {
          cause: error,
        },
      );
    }

    current = await validateOutboundUrl(redirectUrl, options);
    validated.push(current);
  }

  return Object.freeze(validated);
}

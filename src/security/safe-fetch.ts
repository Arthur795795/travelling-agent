import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

export type SafeFetchErrorCode =
  | "INVALID_URL"
  | "BLOCKED_ADDRESS"
  | "TOO_MANY_REDIRECTS"
  | "TIMEOUT"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "RESPONSE_TOO_LARGE"
  | "UPSTREAM_ERROR";

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode;

  constructor(code: SafeFetchErrorCode, message: string) {
    super(message);
    this.name = "SafeFetchError";
    this.code = code;
  }
}

export interface SafeFetchDependencies {
  /** Test-only/custom transport seam. The production transport pins the validated IP. */
  fetchImpl?: typeof fetch;
  requestImpl?: (
    url: URL,
    validatedAddress: string,
    signal: AbortSignal,
  ) => Promise<Response>;
  resolveHostname?: (hostname: string) => Promise<string[]>;
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface SafeFetchResult {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

function ipv4Number(address: string): number | undefined {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return undefined;
  return parts.reduce((value, part) => value * 256 + part, 0) >>> 0;
}

function inIpv4Range(value: number, base: string, prefix: number): boolean {
  const baseValue = ipv4Number(base);
  if (baseValue === undefined) return false;
  const shift = 32 - prefix;
  return shift === 32 || value >>> shift === baseValue >>> shift;
}

function blockedIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === undefined) return true;
  const reservedRanges: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  return reservedRanges.some(([base, prefix]) =>
    inIpv4Range(value, base, prefix),
  );
}

function ipv6Number(address: string): bigint | undefined {
  const withoutZone = address.toLowerCase().split("%", 1)[0];
  if (isIP(withoutZone) !== 6) return undefined;
  let normalized = withoutZone;
  const dottedMatch = normalized.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dottedMatch) {
    const ipv4 = ipv4Number(dottedMatch[2]);
    if (ipv4 === undefined) return undefined;
    normalized = `${dottedMatch[1]}${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const groups =
    halves.length === 2
      ? [...left, ...Array(missing).fill("0"), ...right]
      : left;
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  )
    return undefined;
  return groups.reduce(
    (value, group) => (value << 16n) | BigInt(`0x${group}`),
    0n,
  );
}

function inIpv6Range(value: bigint, base: string, prefix: number): boolean {
  const baseValue = ipv6Number(base);
  if (baseValue === undefined) return false;
  const shift = BigInt(128 - prefix);
  return value >> shift === baseValue >> shift;
}

function embeddedIpv4(value: bigint): string {
  const ipv4 = Number(value & 0xffff_ffffn) >>> 0;
  return [24, 16, 8, 0]
    .map((shift) => String((ipv4 >>> shift) & 0xff))
    .join(".");
}

function blockedIpv6(address: string): boolean {
  const value = ipv6Number(address);
  if (value === undefined) return true;

  // URL parsers normalize ::ffff:127.0.0.1 to ::ffff:7f00:1, so classify
  // mapped and NAT64 values through their embedded IPv4 address.
  if (
    inIpv6Range(value, "::ffff:0:0", 96) ||
    inIpv6Range(value, "64:ff9b::", 96)
  ) {
    return blockedIpv4(embeddedIpv4(value));
  }

  // Accept only globally routable unicast space and exclude special-use ranges
  // that sit inside 2000::/3.
  if (!inIpv6Range(value, "2000::", 3)) return true;
  return (
    inIpv6Range(value, "2001::", 32) ||
    inIpv6Range(value, "2001:20::", 28) ||
    inIpv6Range(value, "2001:db8::", 32) ||
    inIpv6Range(value, "2002::", 16)
  );
}

export function isBlockedAddress(address: string): boolean {
  const version = isIP(address.split("%", 1)[0]);
  return version === 4
    ? blockedIpv4(address)
    : version === 6
      ? blockedIpv6(address)
      : true;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map(({ address }) => address);
}

async function publicAddresses(
  url: URL,
  resolveHostname: (hostname: string) => Promise<string[]>,
): Promise<string[]> {
  if (
    !(url.protocol === "http:" || url.protocol === "https:") ||
    url.username ||
    url.password
  ) {
    throw new SafeFetchError(
      "INVALID_URL",
      "Only public HTTP or HTTPS URLs are allowed",
    );
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname.toLowerCase() === "localhost")
    throw new SafeFetchError("BLOCKED_ADDRESS", "Local addresses are blocked");
  const addresses = isIP(hostname)
    ? [hostname]
    : await resolveHostname(hostname);
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
    throw new SafeFetchError(
      "BLOCKED_ADDRESS",
      "Private, reserved, or unresolved addresses are blocked",
    );
  }
  return addresses;
}

function pinnedRequest(
  url: URL,
  address: string,
  signal: AbortSignal,
): Promise<Response> {
  const requestModule = url.protocol === "https:" ? https : http;
  const originalHostname = url.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve, reject) => {
    const request = requestModule.request(
      {
        protocol: url.protocol,
        hostname: address,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        signal,
        servername:
          url.protocol === "https:" && !isIP(originalHostname)
            ? originalHostname
            : undefined,
        headers: {
          Accept: "text/html,application/xhtml+xml,application/json,text/plain",
          Host: url.host,
        },
      },
      (incoming) => {
        const status = incoming.statusCode ?? 502;
        const body =
          status === 204 || status === 205 || status === 304
            ? null
            : new ReadableStream<Uint8Array>({
                start(controller) {
                  incoming.on("data", (chunk: Buffer) =>
                    controller.enqueue(new Uint8Array(chunk)),
                  );
                  incoming.on("end", () => controller.close());
                  incoming.on("error", (error) => controller.error(error));
                },
                cancel() {
                  incoming.destroy();
                },
              });
        resolve(
          new Response(body, {
            status,
            headers: incoming.headers as HeadersInit,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function waitWithinDeadline<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted)
    return Promise.reject(
      new SafeFetchError("TIMEOUT", "External request timed out"),
    );
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new SafeFetchError("TIMEOUT", "External request timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function validateLimits({
  timeoutMs,
  maxBytes,
  maxRedirects,
}: Required<
  Pick<SafeFetchOptions, "timeoutMs" | "maxBytes" | "maxRedirects">
>): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new SafeFetchError("INVALID_URL", "Timeout must be positive");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new SafeFetchError(
      "INVALID_URL",
      "Maximum response size must be positive",
    );
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0)
    throw new SafeFetchError(
      "INVALID_URL",
      "Maximum redirects must not be negative",
    );
}

export async function safeFetchText(
  input: string,
  options: SafeFetchOptions = {},
  dependencies: SafeFetchDependencies = {},
): Promise<SafeFetchResult> {
  const resolveHostname = dependencies.resolveHostname ?? defaultResolve;
  const limits = {
    timeoutMs: options.timeoutMs ?? 8_000,
    maxBytes: options.maxBytes ?? 1_000_000,
    maxRedirects: options.maxRedirects ?? 3,
  };
  validateLimits(limits);
  let current: URL;
  try {
    current = new URL(input);
  } catch {
    throw new SafeFetchError("INVALID_URL", "URL is invalid");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  const onExternalAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) onExternalAbort();
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    for (
      let redirectCount = 0;
      redirectCount <= limits.maxRedirects;
      redirectCount += 1
    ) {
      const addresses = await waitWithinDeadline(
        publicAddresses(current, resolveHostname),
        controller.signal,
      );
      const response = await waitWithinDeadline(
        dependencies.requestImpl
          ? dependencies.requestImpl(current, addresses[0], controller.signal)
          : dependencies.fetchImpl
            ? dependencies.fetchImpl(current, {
                method: "GET",
                redirect: "manual",
                signal: controller.signal,
                headers: {
                  Accept:
                    "text/html,application/xhtml+xml,application/json,text/plain",
                },
              })
            : pinnedRequest(current, addresses[0], controller.signal),
        controller.signal,
      );

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location)
          throw new SafeFetchError(
            "UPSTREAM_ERROR",
            "Redirect has no location",
          );
        if (redirectCount === limits.maxRedirects)
          throw new SafeFetchError("TOO_MANY_REDIRECTS", "Too many redirects");
        try {
          current = new URL(location, current);
        } catch {
          throw new SafeFetchError("INVALID_URL", "Redirect URL is invalid");
        }
        continue;
      }

      const contentType =
        response.headers
          .get("content-type")
          ?.split(";", 1)[0]
          .trim()
          .toLowerCase() ?? "";
      const allowedTypes = new Set([
        "text/html",
        "application/xhtml+xml",
        "application/json",
        "text/plain",
      ]);
      if (!allowedTypes.has(contentType)) {
        await response.body?.cancel().catch(() => undefined);
        throw new SafeFetchError(
          "UNSUPPORTED_CONTENT_TYPE",
          "Response type is not readable text",
        );
      }
      const declaredSize = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredSize) && declaredSize > limits.maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new SafeFetchError("RESPONSE_TOO_LARGE", "Response is too large");
      }

      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      const reader = response.body?.getReader();
      if (reader) {
        while (true) {
          const { done, value } = await waitWithinDeadline(
            reader.read(),
            controller.signal,
          );
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > limits.maxBytes) {
            await reader.cancel();
            throw new SafeFetchError(
              "RESPONSE_TOO_LARGE",
              "Response is too large",
            );
          }
          chunks.push(value);
        }
      }
      const bytes = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return {
        url: current.toString(),
        status: response.status,
        contentType,
        body: new TextDecoder().decode(bytes),
      };
    }
  } catch (error) {
    if (error instanceof SafeFetchError) throw error;
    if (controller.signal.aborted)
      throw new SafeFetchError("TIMEOUT", "External request timed out");
    throw new SafeFetchError("UPSTREAM_ERROR", "External request failed");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
  throw new SafeFetchError("TOO_MANY_REDIRECTS", "Too many redirects");
}

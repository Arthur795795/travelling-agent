import {
  ProxyAgent,
  fetch as undiciFetch,
  type Dispatcher,
} from "undici";
import { rootCertificates } from "node:tls";

export type AmapRequestInit = RequestInit & {
  /** Undici-only dispatcher. It is always derived from server configuration. */
  dispatcher?: Dispatcher;
};

export type AmapFetch = (
  input: string | URL,
  init?: AmapRequestInit,
) => Promise<Response>;

export interface AmapTransport {
  readonly proxyConfigured: boolean;
  readonly fetch: AmapFetch;
  close(): Promise<void>;
}

interface AmapTransportOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: AmapFetch;
  proxyAgentFactory?: (proxyUrl: string) => Dispatcher;
}

export class AmapNetworkConfigurationError extends Error {
  readonly code = "AMAP_NETWORK_CONFIGURATION_INVALID";

  constructor() {
    super("Amap network configuration is invalid");
    this.name = "AmapNetworkConfigurationError";
  }
}

function proxyUrlFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const raw = environment.AMAP_HTTPS_PROXY?.trim();
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !parsed.hostname ||
      (parsed.pathname !== "/" && parsed.pathname !== "") ||
      parsed.search ||
      parsed.hash
    )
      throw new TypeError("unsupported proxy URL");
    return parsed.href;
  } catch {
    // The raw URL may contain credentials, so it must never reach an error.
    throw new AmapNetworkConfigurationError();
  }
}

/** Creates an Amap-only server transport without changing global fetch. */
export function createAmapTransport(
  options: AmapTransportOptions = {},
): AmapTransport {
  const environment = options.environment ?? process.env;
  const proxyUrl = proxyUrlFromEnvironment(environment);
  const dispatcher = proxyUrl
    ? (options.proxyAgentFactory?.(proxyUrl) ??
      new ProxyAgent({
        uri: proxyUrl,
        proxyTls: { ca: [...rootCertificates] },
        requestTls: { ca: [...rootCertificates] },
      }))
    : undefined;
  const directFetch: AmapFetch =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const proxyFetch = options.fetchImpl ?? (undiciFetch as unknown as AmapFetch);

  return {
    proxyConfigured: Boolean(dispatcher),
    fetch: (input, init) =>
      dispatcher
        ? proxyFetch(input, { ...init, dispatcher })
        : directFetch(input, init),
    close: async () => {
      if (dispatcher) await dispatcher.close();
    },
  };
}

const globals = globalThis as typeof globalThis & {
  travelAmapTransport?: AmapTransport;
};

export function amapTransport(): AmapTransport {
  return (globals.travelAmapTransport ??= createAmapTransport());
}

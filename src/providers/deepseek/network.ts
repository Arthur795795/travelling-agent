import {
  ProxyAgent,
  fetch as undiciFetch,
  type Dispatcher,
} from "undici";
import { rootCertificates } from "node:tls";

export type DeepSeekRequestInit = RequestInit & {
  /** Undici-only request dispatcher; never supplied by browser input. */
  dispatcher?: Dispatcher;
};

export type DeepSeekFetch = (
  input: string | URL,
  init?: DeepSeekRequestInit,
) => Promise<Response>;

export interface DeepSeekTransport {
  readonly baseUrl: string;
  readonly proxyConfigured: boolean;
  readonly fetch: DeepSeekFetch;
  close(): Promise<void>;
}

interface DeepSeekTransportOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: DeepSeekFetch;
  proxyAgentFactory?: (proxyUrl: string) => Dispatcher;
}

export class DeepSeekNetworkConfigurationError extends Error {
  readonly code = "DEEPSEEK_NETWORK_CONFIGURATION_INVALID";

  constructor() {
    super("DeepSeek network configuration is invalid");
    this.name = "DeepSeekNetworkConfigurationError";
  }
}

function proxyUrlFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const raw = environment.DEEPSEEK_HTTPS_PROXY?.trim();
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
    // Never put the raw URL in an exception: it may contain proxy credentials.
    throw new DeepSeekNetworkConfigurationError();
  }
}

export function deepSeekBaseUrl(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return (environment.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(
    /\/$/,
    "",
  );
}

/**
 * Creates the server-only DeepSeek transport. The proxy is read exclusively
 * from process configuration and is attached per request, never globally.
 */
export function createDeepSeekTransport(
  options: DeepSeekTransportOptions = {},
): DeepSeekTransport {
  const environment = options.environment ?? process.env;
  const proxyUrl = proxyUrlFromEnvironment(environment);
  const dispatcher = proxyUrl
    ? (options.proxyAgentFactory?.(proxyUrl) ??
      new ProxyAgent({
        uri: proxyUrl,
        // Keep verification enabled while making the trust source explicit.
        // This avoids Node/Undici proxy tunnels losing the bundled root set.
        proxyTls: { ca: [...rootCertificates] },
        requestTls: { ca: [...rootCertificates] },
      }))
    : undefined;
  const directFetch: DeepSeekFetch =
    options.fetchImpl ??
    ((input, init) => globalThis.fetch(input, init));
  const proxyFetch =
    options.fetchImpl ?? (undiciFetch as unknown as DeepSeekFetch);

  return {
    baseUrl: deepSeekBaseUrl(environment),
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
  travelDeepSeekTransport?: DeepSeekTransport;
};

/** Shared by Key validation and all formal Responses calls in this process. */
export function deepSeekTransport(): DeepSeekTransport {
  return (globals.travelDeepSeekTransport ??= createDeepSeekTransport());
}

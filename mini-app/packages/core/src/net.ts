import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

const proxied = Boolean(process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy);
const agent = proxied ? new EnvHttpProxyAgent() : null;

/**
 * Outbound fetch that honours HTTPS_PROXY / NO_PROXY through undici, so a
 * host framework's patched global fetch cannot drop the proxy a machine
 * needs. Without a proxy configured it is the global fetch.
 */
export const proxyAwareFetch: typeof fetch = agent
  ? ((input, init) => undiciFetch(input as never, { ...(init as object), dispatcher: agent } as never) as unknown as Promise<Response>)
  : fetch;

import { CURRENT_PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER } from "@vykor/protocol";

/** HTTP transport for host-owned daemon probes and maintenance requests. */
export function requestDaemon(endpoint: { url: string; token: string }, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${endpoint.token}`);
  headers.set(PROTOCOL_VERSION_HEADER, String(CURRENT_PROTOCOL_VERSION));
  return fetch(new URL(path, endpoint.url), { ...init, headers });
}

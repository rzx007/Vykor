import {
  WebProviderError,
  type WebFetchFunction,
  type WebFetchProvider,
  type WebFetchProviderRequest,
  type WebFetchProviderResult,
} from "../types.js";

export interface HttpFetchProviderOptions {
  fetchFn?: WebFetchFunction;
  userAgent?: string;
}

export class HttpFetchProvider implements WebFetchProvider {
  readonly name = "http-fetch";
  private readonly fetchFn: WebFetchFunction;
  private readonly userAgent: string;

  constructor(options: HttpFetchProviderOptions = {}) {
    this.fetchFn = options.fetchFn ?? defaultFetch;
    this.userAgent = options.userAgent ?? "Vykor/0.1";
  }

  available() {
    return { available: true as const };
  }

  async fetch(request: WebFetchProviderRequest, signal?: AbortSignal): Promise<WebFetchProviderResult> {
    const url = resolveHttpUrl(request.url, this.name);
    let response;
    try {
      response = await this.fetchFn(url.toString(), {
        headers: { "User-Agent": this.userAgent },
        redirect: "follow",
        signal,
      });
    } catch (error) {
      throw new WebProviderError("network_failure", errorMessage(error), {
        provider: this.name,
        cause: error,
      });
    }

    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      throw new WebProviderError("response_read_failed", errorMessage(error), {
        provider: this.name,
        status: response.status,
        statusText: response.statusText,
        cause: error,
      });
    }

    return {
      provider: this.name,
      url: response.url || url.toString(),
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      contentType: response.headers.get("content-type") ?? "",
      body,
    };
  }
}

function resolveHttpUrl(rawUrl: string, provider: string): URL {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    return url;
  } catch {
    throw new WebProviderError(
      "invalid_request",
      "url must be a valid HTTP or HTTPS URL.",
      { provider },
    );
  }
}

function defaultFetch(url: string, init: Parameters<WebFetchFunction>[1]) {
  return fetch(url, init);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

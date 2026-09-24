import { decodeHtmlEntities } from "../runtime.js";
import {
  WebProviderError,
  type WebFetchFunction,
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchResult,
  type WebSearchSource,
} from "../types.js";

const DEFAULT_ENDPOINT = "https://html.duckduckgo.com/html/";

export interface DuckDuckGoSearchProviderOptions {
  endpoint?: string;
  fetchFn?: WebFetchFunction;
  userAgent?: string;
}

export class DuckDuckGoSearchProvider implements WebSearchProvider {
  readonly name = "duckduckgo-html";
  private readonly endpoint: string;
  private readonly fetchFn: WebFetchFunction;
  private readonly userAgent: string;

  constructor(options: DuckDuckGoSearchProviderOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.fetchFn = options.fetchFn ?? defaultFetch;
    this.userAgent = options.userAgent ?? "Vykor/0.1";
  }

  available() {
    try {
      const endpoint = new URL(this.endpoint);
      if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
        return { available: false as const, reason: "Search endpoint must use HTTP or HTTPS." };
      }
      return { available: true as const };
    } catch {
      return { available: false as const, reason: "Search endpoint is not a valid URL." };
    }
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const endpoint = resolveEndpoint(request.searchUrl ?? this.endpoint, this.name);
    endpoint.searchParams.set("q", request.query);

    let response;
    try {
      response = await this.fetchFn(endpoint.toString(), {
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

    if (!response.ok) {
      throw new WebProviderError(
        "http_status",
        `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
        {
          provider: this.name,
          status: response.status,
          statusText: response.statusText,
        },
      );
    }

    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      throw new WebProviderError("response_read_failed", errorMessage(error), {
        provider: this.name,
        cause: error,
      });
    }

    const sources = parseDuckDuckGoSearchResults(body, request.maxResults);
    if (sources.length === 0 && /class="[^"]*(?:result__a|result-link)/i.test(body)) {
      throw new WebProviderError(
        "parse_failed",
        "DuckDuckGo returned result markup that could not be parsed.",
        { provider: this.name },
      );
    }
    return { provider: this.name, sources };
  }
}

export function parseDuckDuckGoSearchResults(body: string, limit: number): WebSearchSource[] {
  const snippets: string[] = [];
  const snippetPattern =
    /<(?:a|div|span)[^>]+class="[^"]*(?:result__snippet|result-snippet)[^"]*"[^>]*>(.*?)<\/(?:a|div|span)>/gis;
  let snippetMatch: RegExpExecArray | null;
  while ((snippetMatch = snippetPattern.exec(body)) !== null) {
    snippets.push(cleanHtml(snippetMatch[1]!));
  }

  const sources: WebSearchSource[] = [];
  const anchorPattern = /<a([^>]+)>([\s\S]*?)<\/a>/gi;
  let resultIndex = 0;
  let anchorMatch: RegExpExecArray | null;
  while ((anchorMatch = anchorPattern.exec(body)) !== null) {
    const attributes = anchorMatch[1]!;
    const classMatch = /class="([^"]+)"/i.exec(attributes);
    if (!classMatch) continue;
    const classNames = classMatch[1]!;
    if (!classNames.includes("result__a") && !classNames.includes("result-link")) continue;

    const hrefMatch = /href="([^"]+)"/i.exec(attributes);
    if (!hrefMatch) continue;
    const title = cleanHtml(anchorMatch[2]!);
    const url = normalizeResultUrl(hrefMatch[1]!);
    const snippet = snippets[resultIndex] ?? "";
    resultIndex++;
    if (title && url) sources.push({ title, url, snippet });
    if (sources.length >= limit) break;
  }
  return sources;
}

function resolveEndpoint(rawEndpoint: string, provider: string): URL {
  try {
    const endpoint = new URL(rawEndpoint);
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new Error();
    return endpoint;
  } catch {
    throw new WebProviderError(
      "invalid_request",
      "searchUrl must be a valid HTTP or HTTPS URL.",
      { provider },
    );
  }
}

function normalizeResultUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl, "https://duckduckgo.com");
    if (
      parsed.hostname.endsWith("duckduckgo.com") &&
      parsed.pathname.startsWith("/l/")
    ) {
      return parsed.searchParams.get("uddg") ?? rawUrl;
    }
  } catch {
    // Keep the provider response visible when it contains a non-standard URL.
  }
  return rawUrl;
}

function cleanHtml(fragment: string): string {
  return decodeHtmlEntities(fragment.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function defaultFetch(url: string, init: Parameters<WebFetchFunction>[1]) {
  return fetch(url, init);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

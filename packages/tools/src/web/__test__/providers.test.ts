import { describe, expect, it, vi } from "vitest";
import { DuckDuckGoSearchProvider } from "../providers/duckduckgo-search.js";
import { HttpFetchProvider } from "../providers/http-fetch.js";
import { WebRuntime } from "../runtime.js";
import {
  type WebFetchFunction,
  type WebFetchProvider,
  type WebHttpResponse,
  type WebSearchProvider,
} from "../types.js";

describe("DuckDuckGoSearchProvider", () => {
  it("parses stable sources and unwraps DuckDuckGo redirect URLs", async () => {
    const fetchFn = vi.fn<WebFetchFunction>(async () => response({
      body: [
        '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Example &amp; docs</a>',
        '<a class="result__snippet">Useful <b>documentation</b></a>',
      ].join("\n"),
    }));
    const provider = new DuckDuckGoSearchProvider({ fetchFn });

    const result = await provider.search({ query: "example docs", maxResults: 5 });

    expect(result).toEqual({
      provider: "duckduckgo-html",
      sources: [{
        title: "Example & docs",
        url: "https://example.com/docs",
        snippet: "Useful documentation",
      }],
    });
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining("q=example+docs"),
      expect.objectContaining({ redirect: "follow" }),
    );
  });

  it("reports HTTP status separately from network and parsing failures", async () => {
    const provider = new DuckDuckGoSearchProvider({
      fetchFn: async () => response({ ok: false, status: 503, statusText: "Unavailable" }),
    });

    await expect(provider.search({ query: "x", maxResults: 5 })).rejects.toMatchObject({
      code: "http_status",
      status: 503,
    });
  });

  it("reports unexpected result markup as a parsing failure", async () => {
    const provider = new DuckDuckGoSearchProvider({
      fetchFn: async () => response({ body: '<a class="result__a">Missing URL</a>' }),
    });

    await expect(provider.search({ query: "x", maxResults: 5 })).rejects.toMatchObject({
      code: "parse_failed",
    });
  });

  it("checks endpoint availability without making a network request", () => {
    const fetchFn = vi.fn<WebFetchFunction>();
    const provider = new DuckDuckGoSearchProvider({ endpoint: "file:///tmp/search", fetchFn });

    expect(provider.available()).toEqual({
      available: false,
      reason: "Search endpoint must use HTTP or HTTPS.",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("HttpFetchProvider", () => {
  it("returns HTTP metadata and body even for non-2xx responses", async () => {
    const provider = new HttpFetchProvider({
      fetchFn: async () => response({
        ok: false,
        status: 404,
        statusText: "Not Found",
        contentType: "text/plain",
        body: "missing",
      }),
    });

    await expect(provider.fetch({ url: "https://example.com/missing" })).resolves.toMatchObject({
      ok: false,
      status: 404,
      statusText: "Not Found",
      body: "missing",
    });
  });

  it("rejects non-HTTP URLs as invalid requests", async () => {
    const provider = new HttpFetchProvider();

    await expect(provider.fetch({ url: "file:///tmp/private" })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });
});

describe("WebRuntime", () => {
  it("reports a missing provider before execution", async () => {
    const runtime = new WebRuntime();

    await expect(runtime.search({ query: "x", maxResults: 5 })).rejects.toMatchObject({
      code: "provider_unavailable",
    });
  });

  it("converts HTML and truncates fetch bodies outside the provider", async () => {
    const fetchProvider: WebFetchProvider = {
      name: "fake-fetch",
      available: () => ({ available: true }),
      async fetch() {
        return {
          provider: "fake-fetch",
          url: "https://example.com/",
          status: 200,
          statusText: "OK",
          ok: true,
          contentType: "text/html",
          body: "<style>hidden</style><p>Hello world</p>",
        };
      },
    };
    const runtime = new WebRuntime({ fetchProvider });

    const result = await runtime.fetch({
      url: "https://example.com",
      format: "text",
      maxChars: 5,
    });

    expect(result.body).toBe("Hello\n...[truncated]");
    expect(result.truncated).toBe(true);
  });

  it("normalizes unknown provider failures as network failures", async () => {
    const searchProvider: WebSearchProvider = {
      name: "broken-search",
      available: () => ({ available: true }),
      async search() {
        throw new Error("socket closed");
      },
    };
    const runtime = new WebRuntime({ searchProvider });

    await expect(runtime.search({ query: "x", maxResults: 5 })).rejects.toEqual(
      expect.objectContaining({
        code: "network_failure",
        provider: "broken-search",
      }),
    );
  });
});

function response(options: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  url?: string;
  contentType?: string;
  body?: string;
} = {}): WebHttpResponse {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? "OK",
    url: options.url ?? "https://example.com/final",
    headers: {
      get: (name) => name.toLowerCase() === "content-type"
        ? (options.contentType ?? "text/html")
        : null,
    },
    text: async () => options.body ?? "",
  };
}

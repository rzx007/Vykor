import { describe, expect, it } from "vitest";
import { createWebFetchTool } from "../fetch.js";
import { createWebSearchTool } from "../search.js";
import {
  WebProviderError,
  type WebFetchRequest,
  type WebRuntimeLike,
  type WebSearchRequest,
} from "../types.js";

describe("web tools", () => {
  it("treats an empty search as a normal result so the query can be refined", async () => {
    const tool = createWebSearchTool(runtime({
      async search() { return { provider: "test-search", sources: [] }; },
    }));
    const result = await tool.execute({ query: "rare term" }, { cwd: process.cwd() });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("rare term") });
  });
  it("keeps the WebSearch result rendering stable", async () => {
    const tool = createWebSearchTool(runtime({
      async search(request) {
        expect(request).toEqual({ query: "vykor", maxResults: 3 });
        return {
          provider: "test-search",
          sources: [{
            title: "Vykor",
            url: "https://example.com",
            snippet: "A result",
          }],
        };
      },
    }));

    const result = await tool.execute({ query: "vykor", maxResults: 3 }, { cwd: process.cwd() });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: [
        "Search results for: vykor",
        "1. Vykor",
        "   URL: https://example.com",
        "   A result",
      ].join("\n"),
    });
  });

  it("renders structured provider errors with their error code", async () => {
    const tool = createWebSearchTool(runtime({
      async search() {
        throw new WebProviderError("parse_failed", "unexpected markup");
      },
    }));

    const result = await tool.execute({ query: "x" }, { cwd: process.cwd() });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "web_search failed [parse_failed]: unexpected markup",
    });
  });

  it("keeps WebFetch headers and body rendering stable", async () => {
    const tool = createWebFetchTool(runtime({
      async fetch(request) {
        expect(request).toEqual({
          url: "https://example.com",
          maxChars: 12000,
          format: "text",
        });
        return {
          provider: "test-fetch",
          url: "https://example.com/final",
          status: 200,
          statusText: "OK",
          ok: true,
          contentType: "text/plain",
          body: "Hello",
          truncated: false,
        };
      },
    }));

    const result = await tool.execute({ url: "https://example.com" }, { cwd: process.cwd() });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "URL: https://example.com/final\nStatus: 200\nContent-Type: text/plain\n\nHello",
    });
  });

  it("marks non-2xx fetch results with a distinct HTTP error code", async () => {
    const tool = createWebFetchTool(runtime({
      async fetch() {
        return {
          provider: "test-fetch",
          url: "https://example.com/missing",
          status: 404,
          statusText: "Not Found",
          ok: false,
          contentType: "text/plain",
          body: "missing",
          truncated: false,
        };
      },
    }));

    const result = await tool.execute({ url: "https://example.com/missing" }, { cwd: process.cwd() });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "web_fetch failed [http_status]: HTTP 404 Not Found",
    });
  });
});

function runtime(overrides: {
  search?: (request: WebSearchRequest, signal?: AbortSignal) => ReturnType<WebRuntimeLike["search"]>;
  fetch?: (request: WebFetchRequest, signal?: AbortSignal) => ReturnType<WebRuntimeLike["fetch"]>;
}): WebRuntimeLike {
  return {
    search: overrides.search ?? (async () => {
      throw new Error("Unexpected search call");
    }),
    fetch: overrides.fetch ?? (async () => {
      throw new Error("Unexpected fetch call");
    }),
  };
}

import { describe, expect, it } from "vitest";
import {
  endpointBelongsToResource,
  normalizeResourceUrl,
  resourceMetadataCandidates,
  validateResourceBinding,
} from "./resource-binding.js";

describe("validateResourceBinding", () => {
  it("does not normalize returned metadata into matching the expected identifier", () => {
    expect(() => validateResourceBinding({ endpoint: "https://mcp.test/mcp", expectedResource: "https://mcp.test/mcp", metadataResource: "https://MCP.TEST/mcp", source: "challenge" })).toThrow();
  });
  it("accepts metadata whose resource exactly matches the discovered endpoint", () => {
    const result = validateResourceBinding({
      endpoint: "https://mcp.linear.app/mcp",
      expectedResource: "https://mcp.linear.app/mcp",
      metadataResource: "https://mcp.linear.app/mcp",
      source: "challenge",
    });
    expect(result.href).toBe("https://mcp.linear.app/mcp");
  });

  it("accepts an endpoint under the advertised resource path", () => {
    expect(validateResourceBinding({
      endpoint: "https://api.test/v1/mcp",
      expectedResource: "https://api.test/v1",
      metadataResource: "https://api.test/v1",
      source: "explicit",
    }).href).toBe("https://api.test/v1");
  });

  it.each([
    { label: "missing resource", metadataResource: "" },
    { label: "trailing slash", metadataResource: "https://mcp.test/mcp/" },
    { label: "different query", metadataResource: "https://mcp.test/mcp?x=1" },
    { label: "different origin", metadataResource: "https://evil.test/mcp" },
    { label: "encoded separator", metadataResource: "https://mcp.test/mcp%2Fextra" },
  ])("rejects $label metadata", ({ metadataResource }) => {
    expect(() => validateResourceBinding({
      endpoint: "https://mcp.test/mcp",
      expectedResource: "https://mcp.test/mcp",
      metadataResource,
      source: "endpoint-well-known",
    })).toThrowError(expect.objectContaining({ code: "oauth-resource-mismatch" }));
  });

  it("rejects a sibling path endpoint and a resource that is not contained", () => {
    expect(() => validateResourceBinding({
      endpoint: "https://mcp.test/api-other",
      expectedResource: "https://mcp.test/api",
      metadataResource: "https://mcp.test/api",
      source: "explicit",
    })).toThrowError(expect.objectContaining({ code: "oauth-resource-mismatch" }));
  });

  it("rejects an endpoint with a different query than a resource that carries one", () => {
    expect(() => validateResourceBinding({
      endpoint: "https://mcp.test/api?x=2",
      expectedResource: "https://mcp.test/api?x=1",
      metadataResource: "https://mcp.test/api?x=1",
      source: "explicit",
    })).toThrowError(expect.objectContaining({ code: "oauth-resource-mismatch" }));
  });

  it("rejects metadata carrying userinfo, a fragment or unsafe protocol", () => {
    for (const metadataResource of [
      "https://user:pass@mcp.test/mcp",
      "https://mcp.test/mcp#frag",
      "http://mcp.test/mcp",
    ]) {
      expect(() => validateResourceBinding({
        endpoint: "https://mcp.test/mcp",
        expectedResource: "https://mcp.test/mcp",
        metadataResource,
        source: "challenge",
      })).toThrow();
    }
  });
});

describe("endpointBelongsToResource", () => {
  const cases: Array<[string, string, boolean]> = [
    ["https://h.test/api", "https://h.test/api", true],
    ["https://h.test/api", "https://h.test/api/", false],
    ["https://h.test/api/v1", "https://h.test/api/", true],
    ["https://h.test/api/v1", "https://h.test/api", true],
    ["https://h.test/api-other", "https://h.test/api", false],
    ["https://h.test/api", "https://h.test/", true],
    ["https://other.test/api", "https://h.test/api", false],
    ["https://h.test:8443/api", "https://h.test/api", false],
    ["https://h.test/api?x=1", "https://h.test/api?x=1", true],
    ["https://h.test/api?x=2", "https://h.test/api?x=1", false],
    ["https://h.test/api%2Fother", "https://h.test/api", false],
  ];
  it.each(cases)("compares %s against %s", (endpoint, resource, expected) => {
    expect(endpointBelongsToResource(new URL(endpoint), new URL(resource))).toBe(expected);
  });
});

describe("resourceMetadataCandidates", () => {
  it("preserves non-root trailing slash in the discovery location", () => {
    expect(resourceMetadataCandidates(new URL("https://h.test/mcp/"))[0]!.url.href).toBe("https://h.test/.well-known/oauth-protected-resource/mcp/");
  });
  it("tries the path well-known with the query, then the origin root", () => {
    const candidates = resourceMetadataCandidates(new URL("https://h.test/mcp?tenant=1"));
    expect(candidates.map(candidate => [candidate.url.href, candidate.source])).toEqual([
      ["https://h.test/.well-known/oauth-protected-resource/mcp?tenant=1", "endpoint-well-known"],
      ["https://h.test/.well-known/oauth-protected-resource", "origin-well-known"],
    ]);
  });

  it("only tries the origin root for a root endpoint", () => {
    const candidates = resourceMetadataCandidates(new URL("https://h.test/"));
    expect(candidates.map(candidate => candidate.url.href)).toEqual([
      "https://h.test/.well-known/oauth-protected-resource",
    ]);
  });
});

describe("normalizeResourceUrl", () => {
  it("allows loopback HTTP only when explicitly enabled", () => {
    expect(normalizeResourceUrl("http://127.0.0.1:8080/mcp", { allowLoopbackHttp: true }).href)
      .toBe("http://127.0.0.1:8080/mcp");
    expect(() => normalizeResourceUrl("http://127.0.0.1:8080/mcp")).toThrow();
    expect(() => normalizeResourceUrl("http://evil.test/mcp")).toThrow();
  });
});

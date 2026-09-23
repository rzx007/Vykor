import { describe, expect, it } from "vitest"
import {
  fromMcpForm,
  mcpTransport,
  parseMcpJson,
  serializeMcpDocument,
  toMcpForm,
  validateMcpEntry,
  type McpEntry,
} from "./mcp-config"

function entry(config: Record<string, unknown>, name = "srv"): McpEntry {
  return { name, config }
}

describe("real MCP config validation", () => {
  it("accepts real stdio, http and sse entries", () => {
    expect(() =>
      validateMcpEntry(entry({ type: "stdio", command: "npx", args: ["beui"], env: { A: "1" }, cwd: "." }))
    ).not.toThrow()
    expect(() =>
      validateMcpEntry(entry({ type: "http", url: "https://mcp.example/mcp", headers: { Accept: "application/json" }, oauth: { scopes: ["read"] } }))
    ).not.toThrow()
    expect(() => validateMcpEntry(entry({ type: "sse", url: "https://mcp.example/sse" }))).not.toThrow()
  })

  it("rejects demo-only fields instead of silently persisting them", () => {
    expect(() => validateMcpEntry(entry({ type: "stdio", command: "node", env_vars: ["A"] }))).toThrow(
      /env_vars/
    )
    expect(() =>
      validateMcpEntry(entry({ type: "http", url: "https://mcp.example/mcp", bearer_token_env_var: "TOKEN" }))
    ).toThrow(/bearer_token_env_var/)
    expect(() =>
      validateMcpEntry(entry({ type: "http", url: "https://mcp.example/mcp", http_headers: {} }))
    ).toThrow(/http_headers/)
    expect(() =>
      validateMcpEntry(entry({ type: "http", url: "https://mcp.example/mcp", env_http_headers: {} }))
    ).toThrow(/env_http_headers/)
  })

  it("requires the transport-specific field and a valid URL", () => {
    expect(() => validateMcpEntry(entry({ type: "stdio" }))).toThrow(/command/)
    expect(() => validateMcpEntry(entry({ type: "http" }))).toThrow(/url/)
    expect(() => validateMcpEntry(entry({ type: "http", url: "ftp://mcp.example" }))).toThrow(/http/)
    expect(() => validateMcpEntry(entry({ type: "http", url: "https://mcp.example/mcp", command: "node" }))).toThrow(
      /command/
    )
  })

  it("validates oauth and headers shapes", () => {
    expect(() =>
      validateMcpEntry(entry({ type: "http", url: "https://mcp.example/mcp", oauth: { scopes: [1] } }))
    ).toThrow(/oauth.scopes/)
    expect(() =>
      validateMcpEntry(entry({ type: "http", url: "https://mcp.example/mcp", oauth: { accessToken: "x" } }))
    ).toThrow(/oauth/)
    expect(() =>
      validateMcpEntry(entry({ type: "http", url: "https://mcp.example/mcp", headers: { A: 1 } }))
    ).toThrow(/headers/)
    expect(() => validateMcpEntry(entry({ type: "stdio", command: "node", enabled: "no" }))).toThrow(/enabled/)
  })

  it("classifies transports", () => {
    expect(mcpTransport({ type: "sse" })).toBe("sse")
    expect(mcpTransport({ type: "http" })).toBe("http")
    expect(mcpTransport({ url: "https://x.test/mcp" })).toBe("http")
    expect(mcpTransport({ command: "node" })).toBe("stdio")
  })
})

describe("parseMcpJson", () => {
  it("parses wrapped and single-object documents", () => {
    expect(parseMcpJson('{"mcpServers":{"a":{"type":"stdio","command":"node"}}}').servers).toEqual([
      { name: "a", config: { type: "stdio", command: "node" } },
    ])
    expect(parseMcpJson('{"name":"b","type":"http","url":"https://x.test/mcp"}').servers).toEqual([
      { name: "b", config: { type: "http", url: "https://x.test/mcp" } },
    ])
  })

  it("rejects duplicate names and existing-name collisions", () => {
    expect(() =>
      parseMcpJson('{"mcpServers":{"a":{"command":"node"},"a":{"command":"bun"}}}')
    ).toThrow()
    expect(() => parseMcpJson('{"name":"a","command":"node"}', { existingNames: ["a"] })).toThrow(/已存在/)
  })

  it("rejects a rename or multiple servers while editing", () => {
    expect(() =>
      parseMcpJson('{"name":"renamed","command":"node"}', { editingName: "original" })
    ).toThrow(/不能修改名称/)
    expect(() =>
      parseMcpJson(
        '{"mcpServers":{"original":{"command":"node"},"other":{"command":"bun"}}}',
        { editingName: "original" }
      )
    ).toThrow(/只能包含一个服务器/)
  })

  it("allows editing an SSE server through JSON", () => {
    const doc = parseMcpJson('{"mcpServers":{"legacy":{"type":"sse","url":"https://x.test/sse"}}}', {
      editingName: "legacy",
    })
    expect(doc.servers[0]).toEqual({
      name: "legacy",
      config: { type: "sse", url: "https://x.test/sse" },
    })
    expect(serializeMcpDocument(doc)).toContain('"sse"')
  })
})

describe("form mapping", () => {
  it("round-trips real stdio and http fields", () => {
    const stdio = entry({ type: "stdio", command: "node", args: ["server.js"], env: { A: "1" }, cwd: "/tmp", enabled: false })
    const stdioForm = toMcpForm(stdio)
    expect(stdioForm.type).toBe("stdio")
    expect(fromMcpForm({ ...stdioForm, command: "bun" })).toEqual({
      name: "srv",
      config: { enabled: false, type: "stdio", command: "bun", args: ["server.js"], env: { A: "1" }, cwd: "/tmp" },
    })

    const http = entry({
      type: "http",
      url: "https://mcp.example/mcp",
      headers: { Accept: "application/json" },
      oauth: { scopes: ["read"], clientId: "client" },
    })
    const httpForm = toMcpForm(http)
    expect(httpForm.scopes).toEqual(["read"])
    expect(fromMcpForm({ ...httpForm, scopes: ["read", "write"] })).toEqual({
      name: "srv",
      config: {
        type: "http",
        url: "https://mcp.example/mcp",
        headers: { Accept: "application/json" },
        oauth: { clientId: "client", scopes: ["read", "write"] },
      },
    })
  })

  it("rejects empty or duplicate pair keys", () => {
    const form = toMcpForm(entry({ type: "http", url: "https://mcp.example/mcp" }))
    expect(() => fromMcpForm({ ...form, headers: [["", "value"]] })).toThrow(/键不能为空/)
    expect(() =>
      fromMcpForm({ ...form, headers: [["Accept", "a"], ["accept", "b"]] })
    ).toThrow(/重复键/)
  })
})

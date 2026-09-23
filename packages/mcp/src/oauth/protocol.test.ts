import { describe, expect, it, vi } from "vitest";
import { discoverOAuth } from "./protocol.js";

describe("discoverOAuth", () => {
  it("reports that OAuth is unnecessary when initialize succeeds without a challenge", async () => {
    const fetch = vi.fn(async () => new Response(
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"public","version":"1"}}}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as unknown as typeof globalThis.fetch;

    await expect(discoverOAuth("https://mcp.public.test/mcp", fetch)).rejects.toMatchObject({
      code: "oauth-not-required",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

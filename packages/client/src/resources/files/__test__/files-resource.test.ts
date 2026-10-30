import { describe, expect, it } from "vitest";
import { CURRENT_PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER, ProtocolDataError } from "@vykor/protocol";
import { VykorClient } from "../../../index.js";

describe("FilesResource", () => {
  it("uses session endpoints, encodes all query values and shares mandatory handshake", async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const controller = new AbortController();
    const file = { path: "src/a.ts", name: "a.ts", kind: "file", sizeBytes: 12, modifiedAt: 123 };
    const client = new VykorClient({
      baseUrl: "http://daemon.test", token: "secret",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        calls.push({ url, init });
        if (url.pathname === "/capabilities") return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: {} });
        if (url.pathname.endsWith("/stat")) return Response.json(file);
        if (url.pathname.endsWith("/text")) return Response.json({ path: "src/a.ts", content: "const x = 1;", encoding: "utf-8", truncated: false });
        if (url.pathname.endsWith("/find")) return Response.json({ path: ".", files: ["src/a.ts"], truncated: false });
        if (url.pathname.endsWith("/search")) return Response.json({ path: ".", matches: [{ path: "src/a.ts", line: 1, text: "const x = 1;" }], truncated: false });
        return Response.json({ path: ".", entries: [file], truncated: false });
      },
    });
    expect(calls).toHaveLength(0);
    await expect(client.files.list("s/id", { path: "src & docs", limit: 7, signal: controller.signal })).resolves.toMatchObject({ entries: [file] });
    await expect(client.files.stat("s/id", "src/a.ts", { signal: controller.signal })).resolves.toEqual(file);
    await expect(client.files.readText("s/id", "src/a.ts", { maxBytes: 64, signal: controller.signal })).resolves.toMatchObject({ encoding: "utf-8", content: "const x = 1;" });
    await expect(client.files.find("s/id", { pattern: "**/*.ts", limit: 8, signal: controller.signal })).resolves.toMatchObject({ files: ["src/a.ts"] });
    await expect(client.files.search("s/id", { query: "a+b & c", include: "**/*.ts", caseSensitive: false, limit: 9, signal: controller.signal })).resolves.toMatchObject({ matches: [{ path: "src/a.ts", line: 1, text: "const x = 1;" }] });
    expect(calls.map(({ url }) => url.pathname)).toEqual(["/capabilities", "/sessions/s%2Fid/files", "/sessions/s%2Fid/files/stat", "/sessions/s%2Fid/files/text", "/sessions/s%2Fid/files/find", "/sessions/s%2Fid/files/search"]);
    expect(calls.slice(1).map(({ url }) => Object.fromEntries(url.searchParams))).toEqual([
      { path: "src & docs", limit: "7" }, { path: "src/a.ts" }, { path: "src/a.ts", maxBytes: "64" },
      { pattern: "**/*.ts", limit: "8" }, { query: "a+b & c", include: "**/*.ts", caseSensitive: "false", limit: "9" },
    ]);
    for (const { url, init } of calls.slice(1)) {
      expect(init?.method).toBe("GET");
      expect(init?.signal).toBe(controller.signal);
      expect(init?.body).toBeUndefined();
      expect(url.searchParams.has("signal")).toBe(false);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
      expect(new Headers(init?.headers).get(PROTOCOL_VERSION_HEADER)).toBe(String(CURRENT_PROTOCOL_VERSION));
    }
  });

  it("rejects malformed successful file responses", async () => {
    const client = new VykorClient({ baseUrl: "http://daemon.test", fetch: async input => Response.json(
      String(input).endsWith("/capabilities") ? { serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: {} } : { path: ".", entries: [] },
    ) });
    await expect(client.files.list("s")).rejects.toBeInstanceOf(ProtocolDataError);
  });

  it("stops a pre-cancelled file request before the handshake or file endpoint", async () => {
    let requests = 0;
    const controller = new AbortController();
    const reason = new Error("cancelled by caller");
    controller.abort(reason);
    const client = new VykorClient({ baseUrl: "http://daemon.test", fetch: async () => { requests++; return Response.json({}); } });
    await expect(client.files.list("s", { signal: controller.signal })).rejects.toBe(reason);
    expect(requests).toBe(0);
  });
});

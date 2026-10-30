import { describe, expect, it, vi } from "vitest";
import { CURRENT_PROTOCOL_VERSION, SessionFileError, type SessionFileErrorCode } from "@vykor/protocol";
import { createSessionFileRoutes } from "../session-files.js";
import { createSystemRoutes } from "../system.js";

function fixture() {
  const files = {
    list: vi.fn(async () => ({ path: ".", entries: [], truncated: false })),
    stat: vi.fn(async () => ({ path: "note.txt", name: "note.txt", kind: "file" as const })),
    readText: vi.fn(async () => ({ path: "note.txt", content: "note", encoding: "utf-8" as const, truncated: false })),
    find: vi.fn(async () => ({ path: ".", files: ["note.txt"], truncated: false })),
    search: vi.fn(async () => ({ path: ".", matches: [], truncated: false })),
  };
  return { files, routes: createSessionFileRoutes(files) };
}

describe("session files HTTP adapter", () => {
  it.each([
    { url: "/s/files?path=src&limit=5", method: "list", args: ["s", { path: "src", limit: 5 }] },
    { url: "/s/files/stat?path=note.txt", method: "stat", args: ["s", "note.txt", {}] },
    { url: "/s/files/text?path=note.txt&maxBytes=4", method: "readText", args: ["s", "note.txt", { maxBytes: 4 }] },
    { url: "/s/files/find?pattern=**%2F*.ts&limit=3", method: "find", args: ["s", { pattern: "**/*.ts", limit: 3 }] },
    { url: "/s/files/search?query=Needle&include=*.ts&caseSensitive=false&limit=2", method: "search", args: ["s", { query: "Needle", include: "*.ts", caseSensitive: false, limit: 2 }] },
  ] as const)("parses $method arguments and passes the request signal separately", async ({ url, method, args }) => {
    const { files, routes } = fixture();
    const request = new Request(`http://daemon.test${url}`, { signal: new AbortController().signal });
    const response = await routes.request(request);
    expect(response.status).toBe(200);
    const expected = [...args.slice(0, -1), { ...(args.at(-1) as object), signal: request.signal }];
    expect(files[method]).toHaveBeenCalledWith(...expected);
    expect(await response.json()).toEqual(await files[method].mock.results[0]!.value);
  });

  it.each([
    "/s/files?cwd=/private", "/s/files?limit=1e2", "/s/files?limit=1&limit=2",
    "/s/files/stat?path=note.txt&extra=1", "/s/files/stat", "/s/files/text?path=../secret",
    "/s/files/text?path=note.txt&maxBytes=0", "/s/files/find?pattern=../*", "/s/files/find",
    "/s/files/search?query=x&caseSensitive=0", "/s/files/search?query=x&signal=ignored",
    "/s/files/search?query=x&query=y", "/s/files/search?query=x&limit=201",
  ])("rejects invalid or unknown query fields before service admission: %s", async url => {
    const { files, routes } = fixture();
    const response = await routes.request(url);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "file_invalid_request", message: expect.any(String) });
    for (const method of Object.values(files)) expect(method).not.toHaveBeenCalled();
  });

  it.each([
    ["file_invalid_request", 400], ["file_forbidden", 403], ["file_not_found", 404],
    ["file_not_text", 415], ["file_not_ready", 503], ["file_not_supported", 501],
    ["file_timeout", 408], ["file_cancelled", 408], ["file_operation_failed", 500],
  ] as const)("maps %s to its stable status", async (code: SessionFileErrorCode, status) => {
    const { files, routes } = fixture();
    files.list.mockRejectedValueOnce(new SessionFileError(code, "Safe file failure"));
    const response = await routes.request("/s/files");
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code, message: "Safe file failure" });
  });

  it("sanitizes unknown failures instead of exposing filesystem details", async () => {
    const { files, routes } = fixture();
    files.list.mockRejectedValueOnce(Object.assign(new Error("private C:\\Users\\owner\\token.txt"), { code: "file_forbidden" }));
    const response = await routes.request("/s/files");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: "file_operation_failed", message: "File operation failed" });
  });

  it.each(["/s/files", "/s/files/stat?path=x", "/s/files/text?path=x", "/s/files/find?pattern=*", "/s/files/search?query=x"])(
    "returns 501 when the application has no files service: %s", async url => {
      const response = await createSessionFileRoutes().request(url);
      expect(response.status).toBe(501);
      expect(await response.json()).toMatchObject({ code: "file_not_supported" });
    },
  );

  it("does not expose a file write route", async () => {
    const { files, routes } = fixture();
    expect((await routes.request("/s/files/text?path=note.txt", { method: "POST", body: "replace" })).status).toBe(404);
    for (const method of Object.values(files)) expect(method).not.toHaveBeenCalled();
  });
});

describe("session files discovery", () => {
  it.each([false, true])("advertises the service only when ready: %s", async ready => {
    const response = await createSystemRoutes({ control: {} as never, sessionFilesReady: ready }).request("/capabilities");
    const body = await response.json();
    expect(body.features.sessionFiles).toBe(ready ? 1 : undefined);
    expect(body.protocol.version).toBe(CURRENT_PROTOCOL_VERSION);
  });

  it("keeps supplied capabilities consistent with the installed service", async () => {
    const response = await createSystemRoutes({ control: {} as never, sessionFilesReady: false,
      capabilities: { serverVersion: "custom", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: { sessionFiles: 1, jobs: 3 } },
    }).request("/capabilities");
    expect((await response.json()).features).toEqual({ jobs: 3 });
  });
});

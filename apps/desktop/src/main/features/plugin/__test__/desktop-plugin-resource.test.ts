import { CURRENT_PROTOCOL_VERSION, HttpTransport } from "@rzx/client";
import { expect, it } from "vitest";
import { DesktopPluginResource } from "../desktop-plugin-resource";

it("reads archive preview and preserves structured installation failures", async () => {
  const requests: Request[] = [];
  const preview = {
    archiveDigest: "a".repeat(64),
    identity: { id: "dev.example.archive", name: "archive", version: "1" },
    requestedPermissions: ["process:spawn"],
    approvalRequired: true,
    inventory: { tools: 1 },
    diagnostics: [],
  };
  const failure = {
    code: "plugin_archive_changed",
    message: "Select the archive again",
    diagnostics: [{ code: "archive_changed" }],
  };
  const plugins = new DesktopPluginResource(new HttpTransport({ baseUrl: "http://daemon.test", fetch: async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/capabilities") return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: {} });
    requests.push(new Request(input, init));
    return path.endsWith("/preview") ? Response.json(preview) : Response.json(failure, { status: 409 });
  } }));
  const file = { cwd: "C:/workspace", archivePath: "C:/archive.zip" };
  const approval = { ...file, expectedArchiveDigest: preview.archiveDigest, approvedPermissions: preview.requestedPermissions };

  await expect(plugins.previewArchive(file)).resolves.toEqual(preview);
  await expect(plugins.installArchive(approval)).rejects.toMatchObject({ name: "VykorApiError", status: 409, body: failure });
  expect(await Promise.all(requests.map(async request => [request.method, new URL(request.url).pathname, await request.json()]))).toEqual([
    ["POST", "/plugins/archive/preview", file],
    ["POST", "/plugins/archive/install", approval],
  ]);
});

it("encodes marketplace source identities and preserves the install operation ID", async () => {
  const requests: Request[] = [];
  const plugins = new DesktopPluginResource(new HttpTransport({ baseUrl: "http://daemon.test", fetch: async (input, init) => {
    if (new URL(String(input)).pathname === "/capabilities") return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: {} });
    requests.push(new Request(input, init));
    return Response.json({});
  } }));
  const install = { cwd: "/work", candidateId: "candidate", operationId: "original", approvedPermissions: [] };

  await plugins.marketplaceSetSourceEnabled("a/b", { enabled: false });
  await plugins.marketplaceInstall(install);

  expect(await Promise.all(requests.map(async request => [request.method, new URL(request.url).pathname, await request.json()]))).toEqual([
    ["PATCH", "/plugins/marketplace/sources/a%2Fb", { enabled: false }],
    ["POST", "/plugins/marketplace/install", install],
  ]);
});

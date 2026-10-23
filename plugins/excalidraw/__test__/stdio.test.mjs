import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, ResourceUpdatedNotificationSchema, ResourceListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
const root = fileURLToPath(new URL("../", import.meta.url));
test("built stdio service: assets, document ACK, idempotency, subscription, local operations and export", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "vykor-excalidraw-"));
  const client = new Client({ name: "excalidraw-verification", version: "1" });
  const events = [];
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, event => events.push(event.params.uri));
  client.setNotificationHandler(ResourceListChangedNotificationSchema, () => events.push("list"));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(root, "dist/server.mjs")], env: { ...process.env, VYKOR_EXCALIDRAW_DATA_DIR: join(temporary, "data"), VYKOR_EXCALIDRAW_SESSION: "a".repeat(64), VYKOR_EXCALIDRAW_WORKSPACE: temporary }, stderr: "pipe" });
  try {
    await client.connect(transport);
    assert.equal(client.getServerCapabilities().resources.subscribe, true);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.find(x => x.name === "commit_scene")._meta.ui.visibility, ["app"]);
    const panel = await client.readResource({ uri: "ui://excalidraw/panel.html" });
    assert.ok(Buffer.byteLength(panel.contents[0].text) < 1024 * 1024);
    const manifest = JSON.parse((await client.readResource({ uri: "ui://excalidraw/assets/assets.json" })).contents[0].text);
    let bytes = 0;
    for (const name of manifest.scripts) {
      const text = (await client.readResource({ uri: `ui://excalidraw/assets/${name}` })).contents[0].text;
      assert.ok(Buffer.byteLength(text) <= 4 * 1024 * 1024); bytes += Buffer.byteLength(text);
    }
    assert.equal(bytes, manifest.scriptBytes);
    assert.ok(bytes > 20 * 1024 * 1024);
    const call = async (name, args) => client.callTool({ name, arguments: args });
    const created = (await call("create_diagram", { title: "测试画板", elements: [{ id: "box", type: "rectangle", x: 10, y: 20, width: 80, height: 50 }], id: "one" })).structuredContent.document;
    assert.equal(created.revision, 1);
    const documents = JSON.parse((await client.readResource({ uri: "excalidraw://documents" })).contents[0].text).documents;
    assert.equal(documents[0].id, "one");
    for (const uri of ["ui://excalidraw/assets/assets.json", "ui://excalidraw/assets/bundle-0.txt", "excalidraw://status", "excalidraw://documents"]) {
      await assert.rejects(client.subscribeResource({ uri }), { code: ErrorCode.InvalidParams }, `Static resource ${uri} must fail locally without breaking the document feed`);
    }
    await client.subscribeResource({ uri: created.uri });
    const original = JSON.parse((await client.readResource({ uri: created.uri })).contents[0].text);
    const commit = { id: "one", expectedRevision: 1, operationId: "save-1", scene: original.scene };
    const saved = (await call("commit_scene", commit)).structuredContent;
    assert.equal(saved.saved, true); assert.equal(saved.operationId, commit.operationId); assert.equal(saved.document.revision, 2);
    assert.deepEqual((await call("commit_scene", commit)).structuredContent, saved);
    const conflict = await call("commit_scene", { ...commit, operationId: "stale" });
    assert.equal(conflict.isError, true); assert.equal(conflict.structuredContent.error.code, "revision_conflict");
    const read = (await call("read_scene", { id: "one", elementIds: ["box"] })).structuredContent;
    assert.equal(read.document.revision, 2); assert.equal(read.elements[0].id, "box");
    const applied = (await call("apply_operations", { id: "one", expectedRevision: 2, operationId: "agent-1", operations: [{ type: "update", id: "box", changes: { backgroundColor: "red" } }] })).structuredContent;
    assert.equal(applied.document.revision, 3);
    const args = { id: "one", expectedRevision: 3, path: "drawing.excalidraw" };
    const exported = await call("export_diagram", args); assert.ok(!exported.isError);
    assert.equal(JSON.parse(await readFile(join(temporary, "drawing.excalidraw"), "utf8")).elements[0].backgroundColor, "red");
    assert.equal((await call("export_diagram", args)).structuredContent.error.code, "file_exists");
    assert.equal((await call("export_diagram", { ...args, path: "../outside.excalidraw" })).structuredContent.error.code, "path_outside_workspace");
    for (const format of ["png", "svg"]) {
      const data = format === "png" ? "iVBORw0KGgo=" : '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';
      const result = await call("save_image", { id: "one", expectedRevision: 3, path: `drawing.${format}`, data, format }); assert.ok(!result.isError);
    }
    assert.ok(events.includes(created.uri)); assert.ok(events.includes("list"));
  } finally { await client.close(); await rm(temporary, { recursive: true, force: true }); }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
test("real stdio read, subscribe, model edit, duplicate and unsubscribe", async () => {
  const root = mkdtempSync(join(tmpdir(), "notes-stdio-"));
  const client = new Client({ name: "notes-test", version: "1" });
  try {
    let notices = 0;
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, notification => { assert.equal(notification.params.uri, "notes://welcome"); notices++; });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("server.mjs")], env: { VYKOR_NOTES_FILE: join(root, "note.json") } }));
    assert.equal(client.getServerCapabilities().resources.subscribe, true);
    assert.deepEqual((await client.listTools()).tools.filter(tool => tool._meta.ui.visibility.join() === "app").map(tool => tool.name), ["list_notes", "save_note_draft"]);
    const html = await client.readResource({ uri: "ui://notes/editor" }); assert.match(html.contents[0].text, /协作笔记/);
    await client.subscribeResource({ uri: "notes://welcome" });
    const args = { operationId: "manual", expectedRevision: 0, text: "hello" };
    assert.equal((await client.callTool({ name: "save_note_draft", arguments: args })).structuredContent.revision, 1);
    assert.equal((await client.callTool({ name: "save_note_draft", arguments: args })).structuredContent.duplicate, true);
    assert.equal((await client.callTool({ name: "apply_note_operations", arguments: { operationId: "model", expectedRevision: 1, start: 0, end: 5, text: "together" } })).structuredContent.text, "together");
    assert.equal(notices, 2);
    await client.unsubscribeResource({ uri: "notes://welcome" });
    await client.callTool({ name: "save_note_draft", arguments: { operationId: "after-stop", expectedRevision: 2, text: "end" } });
    assert.equal(notices, 2); assert.equal(JSON.parse((await client.readResource({ uri: "notes://welcome" })).contents[0].text).revision, 3);
  } finally { await client.close(); rmSync(root, { recursive: true, force: true }); }
});

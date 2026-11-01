import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { createDefaultNodeAgent, type VykorAgent } from "@vykor/agent-runtime";
import type { StreamingMessageClient, ToolDefinition } from "@vykor/agent-contracts";
import type { Settings } from "@vykor/host-config";
import { SessionStore } from "@vykor/services";
import { createFileReadTool } from "@vykor/tools";
import { expect, it } from "vitest";

import { createOfficeRunner, officeBinaryPath } from "../../../../services/src/office/office-engine.mjs";
import { DaemonApplication } from "../daemon-application.js";

const officeEngine = await officeBinaryPath().catch(() => undefined);

it.skipIf(!officeEngine)("reopens Word, Excel, PowerPoint and long text attachments after a daemon restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vykor-attachment-documents-"));
  const path = join(directory, "sessions.db");
  const settings: Settings = {
    model: "text", provider: "fixture", apiFormat: "openai", maxTurns: 1,
    permission: { mode: "full_access" }, sandbox: { enabled: false },
    plugins: { enabled: false }, memory: { enabled: false },
    customProviders: [{ id: "fixture", displayName: "Fixture", baseUrl: "https://fixture.invalid/v1", apiFormat: "openai",
      models: [{ id: "text", displayName: "Text", imageInputSupport: "unsupported" }] }],
  };
  const client: StreamingMessageClient = { async *streamMessage() {
    yield { type: "text_delta", delta: "Ready." };
    yield { type: "complete", stopReason: "end_turn" };
  } };
  let store = new SessionStore({ path });
  let application: DaemonApplication | undefined;
  let readTool: ToolDefinition | undefined;
  const agents: VykorAgent[] = [];
  const openApplication = async () => {
    const app = new DaemonApplication({ store, settings, log: () => {}, createAgent: async context => {
      readTool = context.options.toolDecorators!.find(tool => tool.name === "Read")!
        .decorate(createFileReadTool({ settings: context.options.settings }));
      const agent = await createDefaultNodeAgent({ ...context.options, client });
      agents.push(agent);
      return { agent, host: agent.host };
    } });
    await app.ready();
    return app;
  };
  const originalFiles: Array<{ path: string; hash: string }> = [];
  try {
    const run = await createOfficeRunner({ cwd: directory, signal: new AbortController().signal, deadline: Date.now() + 180_000 });
    const sources: Array<{ displayName: string; bytes: Uint8Array; marker: string }> = [];
    for (const format of ["docx", "xlsx", "pptx"] as const) {
      const file = join(directory, `sample.${format}`);
      const marker = `${format}-restored-content`;
      await run(["create", file]);
      try {
        const operation = format === "docx"
          ? { command: "add", parent: "/body", type: "paragraph", props: { text: marker } }
          : format === "xlsx"
            ? { command: "set", path: "/Sheet1/A1", props: { value: marker } }
            : { command: "add", parent: "/", type: "slide", props: { title: marker } };
        await run(["batch", file, "--stop-on-error"], [operation]);
      } finally {
        await run(["close", file], undefined, true);
      }
      const bytes = readFileSync(file);
      originalFiles.push({ path: file, hash: createHash("sha256").update(bytes).digest("hex") });
      sources.push({ displayName: `sample.${format}`, bytes, marker });
    }
    sources.push({ displayName: "long.txt", bytes: Buffer.from("begin\n" + "long text line\n".repeat(1500) + "long-text-tail"), marker: "long-text-tail" });
    application = await openApplication();
    const session = application.commands.createSession({ cwd: directory, model: settings.model });
    const assets: Array<{ assetId: string; displayName: string; marker: string }> = [];
    for (const source of sources) {
      const asset = await application.attachments.import({ displayName: source.displayName, content: new Blob([source.bytes]).stream() });
      assets.push({ assetId: asset.id, displayName: source.displayName, marker: source.marker });
    }
    const admitted = await application.interactions.admitPrompt(session.id, { content: "Keep these documents available.", attachments: assets.map(({ assetId }) => ({ assetId })) });
    await expect(application.runControl.awaitRun(session.id, admitted.run!.id)).resolves.toMatchObject({ status: "completed" });
    await application.close();
    store.close();
    store = new SessionStore({ path });
    application = await openApplication();
    await application.control.inspectRuntimeHooks(session.id);
    expect(agents).toHaveLength(2);
    const replay = JSON.stringify(agents[1]!.getHistory());
    for (const asset of assets) {
      const uri = `attachment://${asset.assetId}/${asset.displayName}`;
      expect(replay).toContain(uri);
      const result = await readTool!.execute({ file_path: uri, offset: 1, limit: 2000 }, {
        cwd: directory, sessionId: session.id, settings,
        requestConfiguration: { model: settings.model, provider: settings.provider, apiFormat: settings.apiFormat },
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(result.content.filter(block => block.type === "text").map(block => block.text).join("\n")).toContain(asset.marker);
    }
    for (const original of originalFiles) {
      expect(createHash("sha256").update(readFileSync(original.path)).digest("hex")).toBe(original.hash);
    }
  } finally {
    await application?.close().catch(() => {});
    store.close();
    const withinTemp = relative(tmpdir(), directory);
    if (!withinTemp || withinTemp.startsWith("..") || isAbsolute(withinTemp)) throw new Error("Fixture escaped temporary directory");
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);

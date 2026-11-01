import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getProjectMemoryDir, type Settings } from "@vykor/host-config";
import type { ToolContext } from "@vykor/agent-contracts";
import { createSaveAttachmentTool } from "../save-attachment.js";
import { HostFileOperations } from "../operations.js";
import { createWslPathResolver } from "@vykor/sandbox";

const bytes = new Uint8Array([0, 255, 128, 13, 10, 65]);
const settings: Settings = { model: "text-only", apiFormat: "openai", maxTurns: 1, permission: { mode: "full_auto" }, sandbox: { enabled: false } };
const uri = "attachment://asset/data.bin";

async function inWorkspace(work: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "vykor-save-attachment-"));
  try { await work(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

describe("SaveAttachment", () => {
  it("saves exact original bytes without putting the body into model output", async () => {
    await inWorkspace(async cwd => {
      const tool = createSaveAttachmentTool({ settings, readAttachment: async () => bytes });
      const result = await tool.execute({ attachment_uri: uri, file_path: "assets/data.bin" }, { cwd });
      expect(result).toMatchObject({ executionState: "completed" });
      expect(result.isError).not.toBe(true);
      expect(await readFile(join(cwd, "assets/data.bin"))).toEqual(Buffer.from(bytes));
      expect(result.metadata?.hostFileFacts).toBeDefined();
      expect(JSON.stringify(result)).not.toContain(Buffer.from(bytes).toString("base64"));
      expect(JSON.stringify(result)).toContain("sha256");
    });
  });

  it("does not overwrite an existing file, including simultaneous saves", async () => {
    await inWorkspace(async cwd => {
      const tool = createSaveAttachmentTool({ settings, readAttachment: async () => bytes });
      const input = { attachment_uri: uri, file_path: "same.bin" };
      const results = await Promise.all([tool.execute(input, { cwd }), tool.execute(input, { cwd })]);
      expect(results.filter(r => !r.isError)).toHaveLength(1);
      expect(results.find(r => r.isError)).toMatchObject({ failureKind: "precondition", executionState: "not_started" });
      await writeFile(join(cwd, "same.bin"), "keep");
      expect(await tool.execute(input, { cwd })).toMatchObject({ isError: true, failureKind: "precondition" });
      expect(await readFile(join(cwd, "same.bin"), "utf8")).toBe("keep");
    });
  });

  it("does not save or expose private paths when the source cannot be authorized or read", async () => {
    await inWorkspace(async cwd => {
      const tool = createSaveAttachmentTool({ settings, readAttachment: async () => { throw new Error("/private/daemon/blob unavailable"); } });
      const result = await tool.execute({ attachment_uri: uri, file_path: "denied.bin" }, { cwd });
      expect(result).toMatchObject({ isError: true, executionState: "not_started" });
      expect(JSON.stringify(result)).not.toContain("/private/daemon");
      await expect(readFile(join(cwd, "denied.bin"))).rejects.toThrow();
    });
  });

  it("keeps the existing sandbox boundary before loading source bytes", async () => {
    await inWorkspace(async cwd => {
      await inWorkspace(async outside => {
        const tool = createSaveAttachmentTool({ settings: { ...settings, sandbox: { enabled: true } }, readAttachment: async () => { throw new Error("must not load"); } });
        const result = await tool.execute({ attachment_uri: uri, file_path: join(outside, "escape.bin") }, { cwd });
        expect(result).toMatchObject({ isError: true, failureKind: "policy", executionState: "not_started" });
        await expect(readFile(join(outside, "escape.bin"))).rejects.toThrow();
      });
    });
  });

  it("protects managed project memory from attachment writes", async () => {
    await inWorkspace(async cwd => {
      const file_path = join(getProjectMemoryDir(cwd), "attachment.bin");
      const tool = createSaveAttachmentTool({ settings, readAttachment: async () => bytes });
      expect(await tool.execute({ attachment_uri: uri, file_path }, { cwd }))
        .toMatchObject({ isError: true, failureKind: "policy", executionState: "not_started" });
      await expect(readFile(file_path)).rejects.toThrow();
    });
  });

  it("delivers newly discovered project rules before creating the attachment file", async () => {
    await inWorkspace(async cwd => {
      await mkdir(join(cwd, "nested"));
      await writeFile(join(cwd, "nested/AGENTS.md"), "Nested attachment handling rule");
      const seen = new Set<string>();
      const context: ToolContext = { cwd, projectInstructions: {
        claim: key => seen.has(key) ? "visible" : "new", canRead: async () => true,
      } };
      const tool = createSaveAttachmentTool({ settings, readAttachment: async () => bytes });
      const input = { attachment_uri: uri, file_path: "nested/file.bin" };
      const first = await tool.execute(input, context);
      expect(first).toMatchObject({ isError: true, failureKind: "precondition", executionState: "not_started" });
      expect(JSON.stringify(first.content)).toContain("Nested attachment handling rule");
      await expect(readFile(join(cwd, "nested/file.bin"))).rejects.toThrow();
      for (const key of first.metadata?.hostProjectInstructionKeys as string[] ?? []) seen.add(key);
      expect(await tool.execute(input, context)).toMatchObject({ executionState: "completed" });
      expect(await readFile(join(cwd, "nested/file.bin"))).toEqual(Buffer.from(bytes));
    });
  });

  it("does not retry or claim success if the backend fails after publishing", async () => {
    await inWorkspace(async cwd => {
      class FailingFiles extends HostFileOperations {
        override async createBytesExclusive(path: string, content: Uint8Array) {
          await super.createBytesExclusive(path, content);
          throw new Error("late failure");
        }
      }
      const context = { cwd, environment: { files: new FailingFiles(), workspace: { kind: "local", hostRoot: cwd, executionRoot: cwd }, paths: { resolve: async (path: string) => ({ executionPath: path }) } } } as unknown as ToolContext;
      const tool = createSaveAttachmentTool({ settings, readAttachment: async () => bytes });
      expect(await tool.execute({ attachment_uri: uri, file_path: join(cwd, "uncertain.bin") }, context))
        .toMatchObject({ isError: true, failureKind: "unknown_outcome", executionState: "unknown" });
      expect(await readFile(join(cwd, "uncertain.bin"))).toEqual(Buffer.from(bytes));
    });
  });

  it.each(["C:\\Windows\\save.bin", "/etc/save.bin"])("rejects a system target %s", async file_path => {
    const tool = createSaveAttachmentTool({ settings, readAttachment: async () => bytes });
    expect(await tool.execute({ attachment_uri: uri, file_path }, { cwd: process.cwd() }))
      .toMatchObject({ isError: true, failureKind: "policy", executionState: "not_started" });
  });

  it("protects Windows system directories addressed through their WSL mount path", async () => {
    const workspace = { kind: "wsl" as const, hostRoot: "C:\\work", executionRoot: "/mnt/c/work", distro: "Ubuntu" };
    const saved = new Map<string, Uint8Array>();
    const context = { cwd: "/mnt/c/work", environment: { workspace, info: { kind: "wsl", pathStyle: "posix" },
      paths: createWslPathResolver(workspace), files: { async createBytesExclusive(path: string, data: Uint8Array) { saved.set(path, data); } },
    } } as unknown as ToolContext;
    const tool = createSaveAttachmentTool({ settings, readAttachment: async () => bytes });
    expect(await tool.execute({ attachment_uri: uri, file_path: "/mnt/c/Windows/saved.bin" }, context))
      .toMatchObject({ isError: true, failureKind: "policy", executionState: "not_started" });
    expect(saved.size).toBe(0);
  });

  it("checks cancellation again after source reading and never publishes a file", async () => {
    await inWorkspace(async cwd => {
      const abort = new AbortController();
      const tool = createSaveAttachmentTool({ settings, readAttachment: async () => { abort.abort(); return bytes; } });
      expect(await tool.execute({ attachment_uri: uri, file_path: "cancelled.bin" }, { cwd, abortSignal: abort.signal }))
        .toMatchObject({ isError: true, executionState: "not_started" });
      await expect(readFile(join(cwd, "cancelled.bin"))).rejects.toThrow();
    });
  });

  it("fails closed when an environment has no exclusive binary creation", async () => {
    await inWorkspace(async cwd => {
      const files = new HostFileOperations();
      Object.defineProperty(files, "createBytesExclusive", { value: undefined });
      const context = { cwd, environment: { files, workspace: { kind: "local", hostRoot: cwd, executionRoot: cwd }, paths: { resolve: async (path: string) => ({ executionPath: path }) } } } as unknown as ToolContext;
      const tool = createSaveAttachmentTool({ settings, readAttachment: async () => bytes });
      expect(await tool.execute({ attachment_uri: uri, file_path: join(cwd, "unsupported.bin") }, context))
        .toMatchObject({ isError: true, executionState: "not_started" });
      await expect(readFile(join(cwd, "unsupported.bin"))).rejects.toThrow();
    });
  });

  it.each([
    { attachment_uri: uri, file_path: "x", overwrite: true },
    { attachment_uri: "", file_path: "x" },
    { attachment_uri: uri, file_path: "" },
  ])("validates input before invoking host services: %j", async input => {
    const tool = createSaveAttachmentTool({ settings, readAttachment: async () => { throw new Error("must not load"); } });
    expect(await tool.execute(input, { cwd: process.cwd() })).toMatchObject({ isError: true, failureKind: "invalid_input", executionState: "not_started" });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionEnvironment, createWslPathResolver } from "@vykor/sandbox";
import type { EnvironmentProcessExecutor, WorkspaceBinding } from "@vykor/environment";
import { createEnvironmentFileSystem } from "@vykor/tools";
import type { ToolContext } from "@vykor/core";

import { createDaemonImageToTextTool } from "../daemon-image-to-text-tool.js";

afterEach(() => vi.unstubAllGlobals());

describe("daemon ImageToText tool", () => {
  it.each(["images/../../outside/private.png", "absolute", "linked/private.png"])(
    "rejects a path outside the session cwd through the real Native reader: %s",
    async (path) => {
      await withNativeImages(async (context, outside) => {
        const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "leaked" } }] })));
        vi.stubGlobal("fetch", fetchSpy);
        const readBytes = vi.spyOn(context.environment!.files, "readBytes");
        const result = await createTool().execute({ image_path: path === "absolute" ? join(outside, "private.png") : path }, context);
        expect(result).toMatchObject({ isError: true, failureKind: "command" });
        expect(result.content[0]?.text).toMatch(/工作目录|workspace|cwd/i);
        expect(readBytes).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["invoice.png", "absolute", "inside-link/invoice.png"])(
    "keeps valid Native image reads inside the session cwd: %s",
    async (path) => {
      await withNativeImages(async (context) => {
        let sentImage: unknown;
        vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
          sentImage = JSON.parse(String(init?.body)).messages[0].content[0];
          return new Response(JSON.stringify({ choices: [{ message: { content: "invoice" } }] }));
        }));
        const result = await createTool().execute({ image_path: path === "absolute" ? join(context.cwd, "invoice.png") : path }, context);
        expect(result.content).toEqual([{ type: "text", text: "invoice" }]);
        expect(sentImage).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AQID" } });
      });
    },
  );

  it("keeps a session root that is itself a symlink usable", async () => {
    await withNativeImages(async (context) => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "invoice" } }] }))));
      const result = await createTool().execute({ image_path: "invoice.png" }, context);
      expect(result.content).toEqual([{ type: "text", text: "invoice" }]);
    }, true);
  });

  it.each(["abc123", "stored.webp"])("preserves image_path media type when a file symlink targets %s", async (filename) => {
    await withNativeImages(async (context) => {
      const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI5sAAAAASUVORK5CYII=";
      const target = join(context.cwd, "blobs", filename);
      await mkdir(join(context.cwd, "blobs"));
      await writeFile(target, Buffer.from(base64, "base64"));
      await symlink(target, join(context.cwd, "alias.png"), "file");
      let sentImage: unknown;
      vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
        sentImage = JSON.parse(String(init?.body)).messages[0].content[0];
        return new Response(JSON.stringify({ choices: [{ message: { content: "invoice" } }] }));
      }));
      const readBytes = vi.spyOn(context.environment!.files, "readBytes");
      const result = await createTool().execute({ image_path: "alias.png" }, context);
      expect(result.content).toEqual([{ type: "text", text: "invoice" }]);
      expect(sentImage).toEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } });
      expect(readBytes).toHaveBeenCalledWith(target);
    });
  });

  it("uses root-authorized local OCR for an attachment", async () => {
    const recognize = vi.fn(async () => ({
      status: "completed" as const,
      text: "invoice 123",
      representationId: "rep-1",
      processor: "light-ocr" as const,
      processorVersion: "1",
      cached: false,
      lineCount: 1,
      durationMs: 2,
    }));
    const tool = createDaemonImageToTextTool({
      authorizationSessions: { resolve: (id) => id === "child" ? "root" : undefined },
      attachmentOcr: { recognize },
    });

    const result = await tool.execute(
      { attachment_id: "att-1" },
      { cwd: "C:/work", sessionId: "child" },
    );

    expect(recognize).toHaveBeenCalledWith(expect.objectContaining({
      authorizationSessionId: "root",
      assetId: "att-1",
    }));
    expect((result.content[0] as { text: string }).text).toContain("invoice 123");
    expect(result.metadata).toMatchObject({ attachmentOcr: { assetId: "att-1" } });
  });

  it("refuses unverifiable custom image paths before reading bytes", async () => {
    const readBytes = vi.fn(async () => Uint8Array.from([1, 2, 3]));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "unsafe" } }] }))));
    const result = await createTool().execute({ image_path: "invoice.png" }, {
      cwd: "/workspace", settings: settings("vision-main", "openai"),
      environment: { info: { kind: "wsl", pathStyle: "posix" },
        paths: { resolve: async (path: string) => ({ executionPath: path.startsWith("/") ? path : `/workspace/${path}` }) },
        files: { readBytes } },
    } as any);
    expect(result).toMatchObject({ isError: true, failureKind: "command" });
    expect(result.content[0]?.text).toMatch(/verif/i);
    expect(readBytes).not.toHaveBeenCalled();
  });

  it.each(["invoice.png", "linked/private.png"])("uses WSL canonical paths and its byte reader for %s", async (imagePath) => {
    const binding: WorkspaceBinding = { kind: "wsl", hostRoot: "D:\\workspace", executionRoot: "/mnt/d/workspace" };
    const commands: string[][] = [];
    let sentImage: unknown;
    const executor: EnvironmentProcessExecutor = {
      execShell: async () => { throw new Error("shell must not run"); },
      async execProcess(argv) {
        commands.push(argv);
        const path = argv.at(-1)!;
        const bytes = argv[0] === "/usr/bin/realpath"
          ? Buffer.from(`${path.includes("linked/") ? "/mnt/d/outside/private.png" : path}\n`)
          : Uint8Array.from([1, 2, 3]);
        return { write() {}, end() {}, onOutput(listener) { listener(bytes); return () => {}; },
          onErrorOutput() { return () => {}; }, wait: async () => ({ exitCode: 0 }), async signal() {} };
      },
    };
    const environment = { workspace: binding, info: { kind: "wsl", pathStyle: "posix" }, process: executor,
      paths: createWslPathResolver(binding, executor) } as any;
    environment.files = createEnvironmentFileSystem(environment);
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      sentImage = JSON.parse(String(init?.body)).messages[0].content[0];
      return new Response(JSON.stringify({ choices: [{ message: { content: "invoice" } }] }));
    }));
    const result = await createTool().execute({ image_path: imagePath }, {
      cwd: binding.hostRoot, settings: settings("vision-main", "openai"), environment,
    });
    if (imagePath.startsWith("linked/")) {
      expect(result).toMatchObject({ isError: true, failureKind: "command" });
      expect(sentImage).toBeUndefined();
      expect(commands.every((argv) => argv[0] === "/usr/bin/realpath")).toBe(true);
    } else {
      expect(result.content).toEqual([{ type: "text", text: "invoice" }]);
      expect(sentImage).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AQID" } });
      expect(commands.at(-1)).toMatchObject(["/bin/sh", "-c", expect.any(String), "vk-read", "/mnt/d/workspace/invoice.png"]);
    }
  });

  it("uses context settings to send a local image to an OpenAI-compatible endpoint", async () => {
    const resolvePath = vi.fn(async (path: string) => ({
      executionPath: path === "/workspace" ? "/workspace" : "/workspace/invoice.png",
      mountPurpose: "workspace" as const,
      mountMode: "rw" as const,
    }));
    const readBytes = vi.fn(async () => new Uint8Array([1, 2, 3]));
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("vision-main");
      expect(body.messages[0].content).toEqual([
        expect.objectContaining({ type: "image_url" }),
        { type: "text", text: "Extract every visible word." },
      ]);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "invoice 123" } }],
      }), { status: 200 });
    }));
    const tool = createTool();

    const result = await tool.execute(
      { image_path: "invoice.png", prompt: "Extract every visible word." },
      {
        cwd: "/workspace",
        settings: settings("vision-main", "openai"),
        environment: {
          info: { kind: "wsl", pathStyle: "posix", networkMode: "host" },
          paths: { resolve: resolvePath, canonicalize: async (path: string) => path },
          files: { readBytes },
        },
      } as any,
    );
    expect(resolvePath).toHaveBeenCalledWith("invoice.png", "read");
    expect(readBytes).toHaveBeenCalledWith("/workspace/invoice.png");
    expect(result.content).toEqual([{ type: "text", text: "invoice 123" }]);
  });

  it("sends an HTTP image URL using the Anthropic message format", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      expect(String(url)).toBe("https://vision.example/v1/messages");
      const body = JSON.parse(String(init?.body));
      expect(body.messages[0].content[0]).toEqual({
        type: "image",
        source: { type: "url", url: "https://images.example/cat.png" },
      });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "a cat" }] }));
    }));

    const result = await createTool().execute(
      { image_url: "https://images.example/cat.png" },
      { cwd: "C:/work", settings: settings("vision-main", "anthropic") } as any,
    );

    expect(result.content).toEqual([{ type: "text", text: "a cat" }]);
  });

  it("blocks image URLs when the effective environment has no network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await createTool().execute(
      { image_url: "https://images.example/cat.png" },
      {
        cwd: "/workspace",
        settings: settings("vision-main", "anthropic"),
        environment: { info: { kind: "wsl", networkMode: "none" } },
      } as any,
    );

    expect(result).toMatchObject({ isError: true, failureKind: "policy" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts an optional prompt with attachment OCR", async () => {
    const recognize = vi.fn(async () => ({
      status: "completed" as const,
      text: "invoice 123",
      representationId: "rep-1",
      processor: "light-ocr" as const,
      processorVersion: "1",
      cached: false,
      lineCount: 1,
      durationMs: 2,
    }));
    const tool = createDaemonImageToTextTool({
      authorizationSessions: { resolve: () => "root" },
      attachmentOcr: { recognize },
    });

    const result = await tool.execute(
      { attachment_id: "att-1", prompt: "Extract the visible text." },
      { cwd: "C:/work", sessionId: "child" },
    );
    expect(result).toMatchObject({
      metadata: { attachmentOcr: { assetId: "att-1" } },
    });
    expect(result.isError).not.toBe(true);
    expect(recognize).toHaveBeenCalledOnce();
  });

  it("rejects combining an attachment with another image source", async () => {
    const recognize = vi.fn();
    const tool = createDaemonImageToTextTool({
      authorizationSessions: { resolve: () => "root" },
      attachmentOcr: { recognize },
    });

    await expect(tool.execute(
      { attachment_id: "att-1", image_path: "invoice.png" },
      { cwd: "C:/work", sessionId: "child" },
    )).resolves.toMatchObject({ isError: true, failureKind: "command" });
    expect(recognize).not.toHaveBeenCalled();
  });

  it("requires runtime settings for vision and redacts provider failures", async () => {
    const tool = createTool();
    await expect(tool.execute(
      { image_url: "https://images.example/cat.png" },
      { cwd: "C:/work" } as any,
    )).resolves.toMatchObject({ isError: true, failureKind: "policy" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `secret-key:${"x".repeat(5000)}`,
      { status: 500 },
    )));
    const result = await tool.execute(
      { image_url: "https://images.example/cat.png" },
      { cwd: "C:/work", settings: { ...settings("vision-main", "openai"), apiKey: "secret-key" } } as any,
    );
    const text = (result.content[0] as { text: string }).text;
    expect(result).toMatchObject({ isError: true, failureKind: "provider" });
    expect(text).not.toContain("secret-key");
    expect(text.length).toBeLessThan(1200);
  });
});

function createTool() {
  return createDaemonImageToTextTool({
    authorizationSessions: { resolve: () => undefined },
    attachmentOcr: { recognize: vi.fn() },
  });
}

function settings(model: string, apiFormat: "openai" | "anthropic") {
  return {
    model,
    apiFormat,
    apiKey: "test-key",
    baseUrl: "https://vision.example",
    maxTurns: 1,
    permission: { mode: "default" as const },
  };
}

async function withNativeImages(run: (context: ToolContext, outside: string) => Promise<void>, linkedRoot = false) {
  const base = await mkdtemp(join(tmpdir(), "oh-vision-path-"));
  const workspace = join(base, "workspace");
  await mkdir(workspace);
  const cwd = linkedRoot ? join(base, "workspace-link") : workspace;
  if (linkedRoot) await symlink(workspace, cwd, process.platform === "win32" ? "junction" : "dir");
  const outside = join(base, "outside");
  await mkdir(join(cwd, "images"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(cwd, "invoice.png"), Uint8Array.from([1, 2, 3]));
  await writeFile(join(outside, "private.png"), Uint8Array.from([9, 9, 9]));
  await symlink(outside, join(cwd, "linked"), process.platform === "win32" ? "junction" : "dir");
  await symlink(cwd, join(cwd, "inside-link"), process.platform === "win32" ? "junction" : "dir");
  const runtimeSettings = settings("vision-main", "openai");
  const baseEnvironment = await createExecutionEnvironment({
    config: { mode: "local", kind: "local", failClosed: false, cwd, sandbox: {} as any },
    settings: runtimeSettings,
    binding: { kind: "local", hostRoot: cwd, executionRoot: cwd },
    sessionId: "vision-fixture", userSkillsRoot: cwd,
  });
  try {
    await run({ cwd, settings: runtimeSettings, environment: { ...baseEnvironment, files: createEnvironmentFileSystem(baseEnvironment) } }, outside);
  } finally {
    await baseEnvironment.release();
    await rm(base, { recursive: true, force: true });
  }
}

import { describe, expect, it } from "vitest";
import type { EnvironmentProcessOptions } from "@vykor/environment";
import { WslFileOperations } from "../operations.js";
import { filterGlobOutput } from "../search/host-search.js";

const files = [...Array.from({ length: 45 }, (_, i) => `unmatched-${i}.txt`), ".hidden.ts", "src/main.js", ".git/ignored.ts", "node_modules/ignored.ts"];
const text = new Map([[".hidden.ts", "needle hidden"], ["src/main.js", "needle source"]]);

function fixture(rg: boolean, rgError = "") {
  const commands: Array<{ argv: string[]; cwd?: string }> = [];
  const operations = new WslFileOperations({ workspace: { executionRoot: "/mnt/d/repo" },
    process: { async execProcess(argv: string[], options?: EnvironmentProcessOptions) {
      commands.push({ argv, cwd: options?.cwd });
      let output = "";
      let stderr = "";
      let exitCode = 0;
      const root = "/mnt/d/repo/sub";
      const relative = (path: string) => path.replace(`${root}/`, "");
      if (argv[0] === "/usr/bin/find") {
        if (argv.includes("-maxdepth")) {
          const prefix = argv[1] === root ? "" : `${relative(argv[1]!)}/`;
          const entries = new Map<string, string>();
          for (const file of files.filter((file) => file.startsWith(prefix))) {
            const parts = file.slice(prefix.length).split("/");
            entries.set(parts[0]!, parts.length > 1 ? "d" : "f");
          }
          output = [...entries].map(([name, type]) => `${name}\t${type}\0`).join("");
        } else output = files.join("\0") + "\0";
      }
      else if (argv[0] === "/bin/sh" && argv[3] === "vk-stat") {
        const path = argv[4]!;
        const file = relative(path);
        if (path === root || files.some((item) => item.startsWith(`${file}/`))) output = "directory";
        else if (files.includes(file)) output = "file";
        else exitCode = 2;
      }
      else if ((argv[0] === "/bin/sh" && argv[3] === "vk-read") || argv[0] === "/usr/bin/head") {
        const file = relative(argv[4]!);
        if (!files.includes(file)) exitCode = 3;
        else output = text.get(file) ?? "no match";
      }
      else if (argv[0] === "/bin/sh" && argv[3] === "vykor-rg") {
        if (!rg) exitCode = 127;
        else if (rgError) { exitCode = 2; stderr = rgError; }
        else {
          if (options?.cwd !== root && options?.cwd !== `${root}/src`) throw new Error("Search transport used the wrong directory");
          if (!argv.includes("--hidden")) throw new Error("Search transport omitted hidden files");
          output = argv.includes("--files") ? "./unmatched.txt\n./.hidden.ts\n./src/main.js\n"
            : argv.at(-1) === "main.js" ? "main.js:1:needle source\n" : ".hidden.ts:1:needle hidden\nsrc/main.js:1:needle source\n";
        }
      } else throw new Error(`Unexpected argv: ${JSON.stringify(argv)}`);
      return { write() {}, end() {}, onOutput(listener: (chunk: Uint8Array) => void) { listener(Buffer.from(output)); return () => {}; },
        onErrorOutput(listener: (chunk: Uint8Array) => void) { listener(Buffer.from(stderr)); return () => {}; }, async wait() { return { exitCode }; }, async signal() {} };
    } },
  } as any);
  return { operations, commands };
}

describe("WSL searches", () => {
  it("finds a late fallback glob match after more than limit times ten candidates", async () => {
    await expect(fixture(false).operations.glob("/mnt/d/repo/sub", "**/*.js", 1)).resolves.toEqual(["src/main.js"]);
  });
  it("finds a late fallback grep match after more than limit times twenty candidates", async () => {
    await expect(fixture(false).operations.grep("/mnt/d/repo/sub", "needle", { include: "**/*.js", caseSensitive: true, limit: 1 }))
      .resolves.toEqual({ matches: ["src/main.js:1:needle source"], truncated: false });
  });
  it("keeps ordinary hidden files in fallback traversal", async () => {
    await expect(fixture(false).operations.glob("/mnt/d/repo/sub", ".hidden.ts", 100)).resolves.toEqual([".hidden.ts"]);
  });
  it.each([true, false])("filters hidden files and brace patterns before limiting with rg available=%s", async (rg) => {
    const { operations, commands } = fixture(rg);
    await expect(operations.glob("/mnt/d/repo/sub", "**/*.{ts,js}", 2)).resolves.toEqual([".hidden.ts", "src/main.js"]);
    expect(commands[0]?.argv[3]).toBe("vykor-rg");
    expect(commands.some(({ argv }) => argv[0] === "/usr/bin/find")).toBe(!rg);
  });

  it.each([true, false])("searches matching files beyond early nonmatches with rg available=%s", async (rg) => {
    const { operations, commands } = fixture(rg);
    await expect(operations.grep("/mnt/d/repo/sub", "needle", { include: "*.{ts,js}", caseSensitive: false, limit: 2 }))
      .resolves.toEqual({ matches: [".hidden.ts:1:needle hidden", "src/main.js:1:needle source"], truncated: false });
    expect(commands.find(({ argv }) => argv[3] === "vykor-rg")?.cwd).toBe("/mnt/d/repo/sub");
  });

  it("returns regex errors without switching search engines", async () => {
    const { operations } = fixture(true, "regex parse error: unclosed character class");
    await expect(operations.grep("/mnt/d/repo/sub", "[", { caseSensitive: true, limit: 20 }))
      .rejects.toMatchObject({ kind: "invalid_input", message: expect.stringContaining("unclosed character class") });
  });

  it("does not mistake a filename containing regex for a regex error", async () => {
    const { operations } = fixture(true, "rg: regex.txt: Permission denied (os error 13)");
    await expect(operations.grep("/mnt/d/repo/sub", "needle", { caseSensitive: true, limit: 20 }))
      .rejects.toMatchObject({ kind: "unknown_outcome", message: expect.stringContaining("Permission denied") });
  });

  it.each([true, false])("can search a single file with rg available=%s", async (rg) => {
    await expect(fixture(rg).operations.grep("/mnt/d/repo/sub/src/main.js", "needle", { caseSensitive: true, limit: 20 }))
      .resolves.toEqual({ matches: ["main.js:1:needle source"], truncated: false });
  });

  it.each(["timeout", "interrupted"])("can stop a stalled WSL stat on %s", async (kind) => {
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const operations = new WslFileOperations({ workspace: { executionRoot: "/workspace" },
      process: { async execProcess(_argv: string[], options?: EnvironmentProcessOptions) {
        signal = options?.signal;
        const result = new Promise<{ exitCode: number }>((resolve) => {
          signal?.addEventListener("abort", () => resolve({ exitCode: 143 }), { once: true });
        });
        return { write() {}, end() {}, onOutput() { return () => {}; }, onErrorOutput() { return () => {}; },
          wait: () => result, async signal() {} };
      } },
    } as any);
    const timer = kind === "interrupted" ? setTimeout(() => controller.abort(), 20) : undefined;
    try {
      await expect(operations.grep("/workspace", "needle", { caseSensitive: true, limit: 20,
        timeoutMs: kind === "timeout" ? 20 : 5000, signal: controller.signal }))
        .rejects.toMatchObject({ kind });
      expect(signal?.aborted).toBe(true);
    } finally { clearTimeout(timer); }
  }, 1000);

  it("keeps brace matching identical for host ripgrep output", () => {
    expect(filterGlobOutput("./ignored.txt\n./src/main.ts\n./.hidden.js\n", "**/*.{ts,js}", 2))
      .toEqual(["src/main.ts", ".hidden.js"]);
  });
});

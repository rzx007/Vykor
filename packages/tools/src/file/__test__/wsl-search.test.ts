import { describe, expect, it } from "vitest";
import type { EnvironmentProcessOptions } from "@vykor/environment";
import { WslFileOperations } from "../operations.js";
import { filterGlobOutput } from "../host-search.js";

const files = [...Array.from({ length: 45 }, (_, i) => `unmatched-${i}.txt`), ".hidden.ts", "src/main.js", ".git/ignored.ts", "node_modules/ignored.ts"];
const text = new Map([[".hidden.ts", "needle hidden"], ["src/main.js", "needle source"]]);

function fixture(rg: boolean) {
  const commands: Array<{ argv: string[]; cwd?: string }> = [];
  const operations = new WslFileOperations({ workspace: { executionRoot: "/mnt/d/repo" },
    process: { async execProcess(argv: string[], options?: EnvironmentProcessOptions) {
      commands.push({ argv, cwd: options?.cwd });
      let output = "";
      let exitCode = 0;
      if (argv[0] === "/usr/bin/find") output = files.join("\0") + "\0";
      else if (argv[0] === "/bin/sh" && argv[3] === "vk-read") output = text.get(argv[4]!.replace("/mnt/d/repo/sub/", "")) ?? "no match";
      else if (argv[0] === "/bin/sh" && argv[3] === "vykor-rg") {
        if (!rg) exitCode = 127;
        else {
          if (options?.cwd !== "/mnt/d/repo/sub") throw new Error("Search transport used the wrong directory");
          if (!argv.includes("--hidden")) throw new Error("Search transport omitted hidden files");
          output = argv.includes("--files") ? "./unmatched.txt\n./.hidden.ts\n./src/main.js\n" : ".hidden.ts:1:needle hidden\nsrc/main.js:1:needle source\n";
        }
      } else throw new Error(`Unexpected argv: ${JSON.stringify(argv)}`);
      return { write() {}, end() {}, onOutput(listener: (chunk: Uint8Array) => void) { listener(Buffer.from(output)); return () => {}; },
        onErrorOutput() { return () => {}; }, async wait() { return { exitCode }; }, async signal() {} };
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
      .resolves.toEqual(["src/main.js:1:needle source"]);
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
      .resolves.toEqual([".hidden.ts:1:needle hidden", "src/main.js:1:needle source"]);
    expect(commands[0]?.cwd).toBe("/mnt/d/repo/sub");
  });

  it("keeps brace matching identical for host ripgrep output", () => {
    expect(filterGlobOutput("./ignored.txt\n./src/main.ts\n./.hidden.js\n", "**/*.{ts,js}", 2))
      .toEqual(["src/main.ts", ".hidden.js"]);
  });
});

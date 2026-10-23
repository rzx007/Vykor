import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostFileOperations, fallbackGrep } from "../../operations.js";
import { filterGrepOutput, runHostProcess, startHostSearch } from "../host-search.js";
import { consumeGrepProcess } from "../grep-search.js";

const directories: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "oh-grep-regression-"));
  directories.push(root);
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "ignored"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "dist"));
  await writeFile(join(root, ".gitignore"), "ignored/\n");
  await writeFile(join(root, ".git", "config"), "needle metadata\n");
  await writeFile(join(root, "ignored", "data.ts"), "needle ignored\n");
  await writeFile(join(root, "dist", "bundle.ts"), "needle generated\n");
  await writeFile(join(root, "src", ".hidden.ts"), "needle hidden\n");
  await writeFile(join(root, "src", "main.ts"), "needle main  \r\n");
  return root;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("grep execution", () => {
  it("does not block the event loop while a process runs", async () => {
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 0);
    try {
      const result = await runHostProcess(process.execPath, ["-e", 'setTimeout(() => console.log("done"), 150)'], { cwd: process.cwd() });
      expect(result.exitCode).toBe(0);
      expect(timerFired).toBe(true);
    } finally { clearTimeout(timer); }
  });

  it("retains stderr on process failure", async () => {
    const result = await runHostProcess(process.execPath, ["-e", 'console.error("invalid pattern"); process.exit(2)'], { cwd: process.cwd() });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("invalid pattern");
  });

  it("preserves spaces and returns nothing for a zero limit", () => {
    expect(filterGrepOutput("a.ts:1:  needle  \r\n", 2)).toEqual(["a.ts:1:  needle  "]);
    expect(filterGrepOutput("a.ts:1:needle\n", 0)).toEqual([]);
  });

  it("uses the same hidden-file and ignore rules in host and fallback searches", async () => {
    const root = await fixture();
    const host = new HostFileOperations();
    const normal = await host.grep(root, "needle", { caseSensitive: true, limit: 20 });
    const fallback = await fallbackGrep(root, "needle", "*.ts", true, 20, host);
    const expected = ["src/.hidden.ts:1:needle hidden", "src/main.ts:1:needle main  "];
    expect(normal.matches.map((line: string) => line.replaceAll("\\", "/")).sort()).toEqual(expected);
    expect(fallback.matches.map((line: string) => line.replaceAll("\\", "/")).sort()).toEqual(expected);
    expect(normal.truncated).toBe(false);
  });

  it("respects nested ignore rules and negations in the fallback", async () => {
    const root = await fixture();
    await writeFile(join(root, "src", ".gitignore"), "*.ts\n!main.ts\n");
    const result = await fallbackGrep(root, "needle", undefined, true, 20);
    expect(result.matches.map((line: string) => line.replaceAll("\\", "/"))).toEqual(["src/main.ts:1:needle main  "]);
  });

  it("reports exact and exceeded limits separately", async () => {
    const root = await fixture();
    const host = new HostFileOperations();
    const exact = await host.grep(join(root, "src", "main.ts"), "needle", { caseSensitive: true, limit: 1 });
    expect(exact).toMatchObject({ truncated: false });
    expect(exact.matches).toHaveLength(1);
    const limited = await host.grep(root, "needle", { caseSensitive: true, limit: 1 });
    expect(limited).toMatchObject({ truncated: true });
    expect(limited.matches).toHaveLength(1);
  });

  it("returns a bounded result even when rg would produce megabytes", async () => {
    const root = await fixture();
    await writeFile(join(root, "large.txt"), ("needle " + "x".repeat(200) + "\n").repeat(20000));
    const result = await new HostFileOperations().grep(root, "needle", { caseSensitive: true, limit: 200 });
    expect(result.truncated).toBe(true);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(result.matches.join("\n"))).toBeLessThanOrEqual(8192);
  });

  it("automatically uses the fallback only when rg cannot be found", async () => {
    const root = await fixture();
    vi.stubEnv("PATH", root);
    const result = await new HostFileOperations().grep(root, "needle", { include: "*.ts", caseSensitive: true, limit: 20 });
    expect(result).toEqual({ matches: ["src/.hidden.ts:1:needle hidden", "src/main.ts:1:needle main  "], truncated: false });
  });

  it("inherits repository ignore rules when searching a subdirectory", async () => {
    const root = await fixture();
    await writeFile(join(root, ".gitignore"), "src/.hidden.ts\n");
    const result = await fallbackGrep(join(root, "src"), "needle", undefined, true, 20);
    expect(result).toEqual({ matches: ["main.ts:1:needle main  "], truncated: false });
  });

  it.each(["timeout", "interrupted"])("terminates a running process on %s", async (kind) => {
    const controller = new AbortController();
    const child = startHostSearch(process.execPath, ["-e", 'setTimeout(() => console.log("late"), 10000)'], process.cwd());
    const timer = kind === "interrupted" ? setTimeout(() => controller.abort(), 30) : undefined;
    try {
      await expect(consumeGrepProcess(() => child, { caseSensitive: true, limit: 20,
        timeoutMs: kind === "timeout" ? 30 : 5000, signal: controller.signal }))
        .rejects.toMatchObject({ kind });
      expect((await child.wait()).exitCode).not.toBe(0);
    } finally { clearTimeout(timer); await child.signal("terminate"); }
  });

  it("includes process startup in the deadline", async () => {
    await expect(consumeGrepProcess(() => new Promise(() => {}), { caseSensitive: true, limit: 20, timeoutMs: 20 }))
      .rejects.toMatchObject({ kind: "timeout" });
  }, 1000);

  it.each(["timeout", "interrupted"])("can stop expensive fallback regex evaluation on %s", async (kind) => {
    const root = await fixture();
    await writeFile(join(root, "expensive.txt"), "a".repeat(12000) + "!");
    const controller = new AbortController();
    const timer = kind === "interrupted" ? setTimeout(() => controller.abort(), 150) : undefined;
    try {
      await expect(fallbackGrep(join(root, "expensive.txt"), "(a+)+$", undefined, true, 20, new HostFileOperations(), {
        timeoutMs: kind === "timeout" ? 150 : 5000, signal: controller.signal,
      })).rejects.toMatchObject({ kind });
    } finally { clearTimeout(timer); }
  });

  it("reports limited scanning when a fallback file exceeds its read budget", async () => {
    const root = await fixture();
    await writeFile(join(root, "huge.txt"), "x".repeat(5 * 1024 * 1024) + "\nneedle late");
    const result = await fallbackGrep(join(root, "huge.txt"), "needle", undefined, true, 20);
    expect(result).toEqual({ matches: [], truncated: true });
  });

  it.each([
    ["", []], ["one\n", []], ["one\n\n", ["blank.txt:2:"]], ["\n", ["blank.txt:1:"]],
  ])("does not invent an empty line at EOF for %j", async (content, matches) => {
    const root = await fixture();
    await writeFile(join(root, "blank.txt"), content as string);
    expect(await fallbackGrep(join(root, "blank.txt"), "^$", undefined, true, 20))
      .toEqual({ matches, truncated: false });
  });

  it("keeps .ignore rules above nested .gitignore negations", async () => {
    const root = await fixture();
    await writeFile(join(root, ".ignore"), "*.ts\n");
    await writeFile(join(root, "src", ".gitignore"), "!main.ts\n");
    const result = await fallbackGrep(root, "needle", undefined, true, 20);
    expect(result).toEqual({ matches: [], truncated: false });
  });

  it("respects repository info/exclude rules in the fallback", async () => {
    const root = await fixture();
    await mkdir(join(root, ".git", "info"));
    await writeFile(join(root, ".git", "info", "exclude"), "src/.hidden.ts\n");
    expect(await fallbackGrep(root, "needle", undefined, true, 20))
      .toEqual({ matches: ["src/main.ts:1:needle main  "], truncated: false });
  });

  it("does not mark results incomplete for oversized matches excluded by include", async () => {
    const root = await fixture();
    await writeFile(join(root, "large.txt"), "needle " + "x".repeat(100 * 1024));
    const result = await new HostFileOperations().grep(root, "needle", { include: "*.ts", caseSensitive: true, limit: 20 });
    expect(result.truncated).toBe(false);
    expect(result.matches).toHaveLength(2);
  });

  it.each([
    ["[ab].ts", ["a.ts:1:needle"]],
    ["[!ab].ts", ["c.ts:1:needle"]],
  ])("supports glob character class %s in include", async (include, matches) => {
    const root = await fixture();
    await writeFile(join(root, "a.ts"), "needle\n");
    await writeFile(join(root, "c.ts"), "needle\n");
    const result = await new HostFileOperations().grep(root, "needle", { include: include as string, caseSensitive: true, limit: 20 });
    expect(result).toEqual({ matches, truncated: false });
  });

  it("preserves UTF-8 characters split between pipe chunks", async () => {
    const result = await consumeGrepProcess((signal) => startHostSearch(process.execPath, ["-e", `
      const bytes = Buffer.from('a.ts:1:中😀👩‍💻  \\r\\n');
      process.stdout.write(bytes.subarray(0, 8));
      setTimeout(() => process.stdout.write(bytes.subarray(8)), 30);
    `], process.cwd(), signal), { caseSensitive: true, limit: 20 });
    expect(result).toEqual({ matches: ["a.ts:1:中😀👩‍💻  "], truncated: false });
  });

  it("aborts the transport signal when stopping at the result limit", async () => {
    let transportSignal: AbortSignal | undefined;
    const result = await consumeGrepProcess((signal) => {
      transportSignal = signal;
      return startHostSearch(process.execPath, ["-e", `
        console.log('a.ts:1:needle'); console.log('b.ts:1:needle');
        setInterval(() => {}, 1000);
      `], process.cwd(), signal);
    }, { caseSensitive: true, limit: 1 });
    expect(result).toEqual({ matches: ["a.ts:1:needle"], truncated: true });
    expect(transportSignal?.aborted).toBe(true);
  });
});

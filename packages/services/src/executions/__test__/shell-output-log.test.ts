import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createShellOutputLogHost } from "../shell-output-log.js";

const directories: string[] = [];
const directory = () => {
  const value = mkdtempSync(join(tmpdir(), "vykor-shell-log-"));
  directories.push(value);
  return value;
};
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("shell output log host", () => {
  it("spills only long output and pages a UTF-8 long line without skipping bytes", async () => {
    const path = directory();
    const host = createShellOutputLogHost({ directory: path });
    const short = host.begin("session-a", 4);
    short.append("1234");
    expect(short.finish(true).reference).toBeUndefined();
    expect(readdirSync(path)).toEqual([]);

    const capture = host.begin("session-a", 4);
    capture.append("A界");
    capture.append("B".repeat(9000));
    const state = capture.finish(true);
    expect(state).toMatchObject({ available: true, complete: true, retainedBytes: 9004, discardedBytes: 0 });
    expect(state.reference).toMatch(/^shell-output:\/\/[0-9a-f-]{36}$/);
    let cursor = 0;
    let output = "";
    for (;;) {
      const page = await host.read({ sessionId: "session-a", reference: state.reference!, cursor, maxBytes: 17 });
      expect(page.status).toBe("ok");
      if (page.status !== "ok") break;
      output += page.text;
      if (page.eof) break;
      expect(page.nextCursor).toBeGreaterThan(cursor);
      cursor = page.nextCursor;
    }
    expect(output).toBe("A界" + "B".repeat(9000));
  });

  it("preserves U+FEFF at the first byte and at later page boundaries", async () => {
    const host = createShellOutputLogHost({ directory: directory() });
    const capture = host.begin("owner", 1);
    capture.append("\uFEFFa\uFEFFb");
    const reference = capture.finish(true).reference!;
    const first = await host.read({ sessionId: "owner", reference, maxBytes: 4 });
    expect(first).toMatchObject({ status: "ok", text: "\uFEFFa", nextCursor: 4, eof: false });
    if (first.status !== "ok") return;
    const second = await host.read({ sessionId: "owner", reference, cursor: first.nextCursor, maxBytes: 4 });
    expect(second).toMatchObject({ status: "ok", text: "\uFEFFb", nextCursor: 8, eof: true });
  });

  it("rejects cross-session, missing-session, malformed reference and invalid cursor uniformly", async () => {
    const host = createShellOutputLogHost({ directory: directory() });
    const capture = host.begin("session-a", 1);
    capture.append("界x");
    const reference = capture.finish(true).reference!;
    expect((await host.read({ sessionId: "session-b", reference })).status).toBe("unavailable");
    expect((await host.read({ reference })).status).toBe("unavailable");
    expect((await host.read({ sessionId: "session-a", reference: "shell-output://../../etc/passwd" })).status).toBe("unavailable");
    expect((await host.read({ sessionId: "session-a", reference: null as unknown as string })).status).toBe("unavailable");
    expect((await host.read({ sessionId: "session-a", reference, cursor: 1 })).status).toBe("invalid_cursor");
    expect((await host.read({ sessionId: "session-a", reference, cursor: 999 })).status).toBe("invalid_cursor");
    const anonymous = host.begin(undefined, 1);
    anonymous.append("long output");
    expect(anonymous.finish(true)).toMatchObject({ available: false, complete: false });
  });

  it("rehydrates completed logs and treats unfinished ones as incomplete after restart", async () => {
    const path = directory();
    const host = createShellOutputLogHost({ directory: path });
    const finished = host.begin("owner", 1);
    finished.append("finished");
    const completeReference = finished.finish(true).reference!;
    const unfinished = host.begin("owner", 1);
    unfinished.append("partial");
    const partialReference = unfinished.finish(false).reference!;
    const restarted = createShellOutputLogHost({ directory: path });
    expect(await restarted.read({ sessionId: "owner", reference: completeReference })).toMatchObject({ status: "ok", complete: true, text: "finished" });
    expect(await restarted.read({ sessionId: "owner", reference: partialReference })).toMatchObject({ status: "ok", complete: false, text: "partial" });
  });

  it.each([false, true])("reads a real child process capture after exit (finish=%s)", async (finish) => {
    const path = directory();
    const packageDir = fileURLToPath(new URL("../../../", import.meta.url));
    const pnpmDir = fileURLToPath(new URL("../../../../../node_modules/.pnpm/", import.meta.url));
    const tsxPackage = readdirSync(pnpmDir).find((name) => /^tsx@\d/.test(name));
    expect(tsxPackage).toBeDefined();
    const tsxCli = join(pnpmDir, tsxPackage!, "node_modules", "tsx", "dist", "cli.mjs");
    const script = `
      import { readdirSync } from "node:fs";
      import { createShellOutputLogHost } from ${JSON.stringify(pathToFileURL(join(packageDir, "src", "executions", "shell-output-log.ts")).href)};
      const directory = process.env.SHELL_LOG_TEST_DIRECTORY;
      const capture = createShellOutputLogHost({ directory }).begin("owner", 1);
      capture.append("child-output");
      if (process.env.SHELL_LOG_TEST_FINISH === "true") capture.finish(true);
      const id = readdirSync(directory).find((name) => name.endsWith(".log")).slice(0, -4);
      process.stdout.write("shell-output://" + id);
    `;
    const childScript = join(path, "child.mts");
    writeFileSync(childScript, script);
    const child = spawnSync(process.execPath, [tsxCli, childScript], {
      cwd: packageDir, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, SHELL_LOG_TEST_DIRECTORY: path, SHELL_LOG_TEST_FINISH: String(finish) },
    });
    expect(child.status, child.stderr).toBe(0);
    const reference = child.stdout.trim();
    expect(reference).toMatch(/^shell-output:\/\/[0-9a-f-]{36}$/);
    const restarted = createShellOutputLogHost({ directory: path });
    expect(await restarted.read({ sessionId: "owner", reference })).toMatchObject({
      status: "ok", text: "child-output", complete: finish,
    });
    expect((await restarted.read({ sessionId: "other", reference })).status).toBe("unavailable");
  });

  it("keeps only the first 10 MiB and reports loss only after rejection", async () => {
    const host = createShellOutputLogHost({ directory: directory() });
    const capture = host.begin("owner", 1);
    capture.append("a".repeat(10 * 1024 * 1024));
    expect(capture.finish(true)).toMatchObject({ retainedBytes: 10 * 1024 * 1024, discardedBytes: 0, complete: true });
    const next = host.begin("owner", 1);
    next.append("a".repeat(10 * 1024 * 1024 + 1));
    expect(next.finish(true)).toMatchObject({ retainedBytes: 10 * 1024 * 1024, discardedBytes: 1, complete: false });

    const boundary = host.begin("owner", 1);
    boundary.append("a".repeat(10 * 1024 * 1024 - 2));
    boundary.append("界");
    boundary.append("B");
    const state = boundary.finish(true);
    expect(state).toMatchObject({ retainedBytes: 10 * 1024 * 1024 - 2, discardedBytes: 4, complete: false });
    const page = await host.read({ sessionId: "owner", reference: state.reference!, cursor: 10 * 1024 * 1024 - 4 });
    expect(page).toMatchObject({ status: "ok", text: "aa", eof: true });
  });

  it("protects active captures across host instances and limits 64 active spills", () => {
    const path = directory();
    const host = createShellOutputLogHost({ directory: path });
    const other = createShellOutputLogHost({ directory: path });
    const active = Array.from({ length: 64 }, (_, index) => {
      const capture = (index % 2 ? host : other).begin("owner", 1);
      capture.append("xy");
      return capture;
    });
    const rejected = host.begin("owner", 1);
    rejected.append("xy");
    expect(rejected.finish(true)).toMatchObject({ available: false });
    expect(active[0]!.finish(true).available).toBe(true);
    const replacement = other.begin("owner", 1);
    replacement.append("xy");
    expect(replacement.finish(true).available).toBe(true);
    active.slice(1).forEach((capture) => capture.finish(false));
  });

  it.each(["missing", "corrupt"])("recovers a full quota of %s-metadata orphan logs", async (kind) => {
    const path = directory();
    const host = createShellOutputLogHost({ directory: path });
    const orphanIds = Array.from({ length: 64 }, () => randomUUID());
    for (const id of orphanIds) {
      writeFileSync(join(path, `${id}.log`), "orphan");
      if (kind === "corrupt") writeFileSync(join(path, `${id}.json`), "{broken");
    }
    writeFileSync(join(path, "unrelated.txt"), "keep");
    const capture = host.begin("owner", 1);
    capture.append("replacement");
    const state = capture.finish(true);
    expect(state).toMatchObject({ available: true, complete: true });
    expect((await host.read({ sessionId: "owner", reference: state.reference! })).status).toBe("ok");
    expect(readdirSync(path).filter((name) => name.endsWith(".log"))).toHaveLength(64);
    expect(readFileSync(join(path, "unrelated.txt"), "utf8")).toBe("keep");
    expect(orphanIds.some((id) => !readdirSync(path).includes(`${id}.log`))).toBe(true);
  });

  it("expires old orphan logs but keeps an active capture even when its file time is old", async () => {
    const path = directory();
    const host = createShellOutputLogHost({ directory: path });
    const active = host.begin("owner", 1);
    active.append("active");
    const activeId = readdirSync(path).find((name) => name.endsWith(".log"))!.slice(0, -4);
    const orphanId = randomUUID();
    const orphanPath = join(path, `${orphanId}.log`);
    writeFileSync(orphanPath, "orphan");
    const unrelatedPath = join(path, "unrelated.txt");
    writeFileSync(unrelatedPath, "keep");
    const linkedId = randomUUID();
    let linked = false;
    try { symlinkSync(unrelatedPath, join(path, `${linkedId}.log`)); linked = true; } catch { /* symlinks may be unavailable */ }
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(orphanPath, old, old);
    utimesSync(join(path, `${activeId}.log`), old, old);
    const fresh = host.begin("owner", 1);
    fresh.append("fresh");
    expect(fresh.finish(true).available).toBe(true);
    expect(readdirSync(path)).not.toContain(`${orphanId}.log`);
    expect(readdirSync(path)).toContain(`${activeId}.log`);
    if (linked) expect(readdirSync(path)).toContain(`${linkedId}.log`);
    expect(readFileSync(unrelatedPath, "utf8")).toBe("keep");
    expect((await host.read({ sessionId: "owner", reference: `shell-output://${activeId}` })).status).toBe("ok");
    active.finish(false);
  });

  it("removes only expired managed files and refuses linked content", async () => {
    const path = directory();
    const host = createShellOutputLogHost({ directory: path });
    const old = host.begin("owner", 1);
    old.append("old");
    const oldReference = old.finish(true).reference!;
    const id = oldReference.slice("shell-output://".length);
    const metadata = join(path, `${id}.json`);
    const record = JSON.parse(readFileSync(metadata, "utf8"));
    record.createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    writeFileSync(metadata, JSON.stringify(record));
    writeFileSync(join(path, "unrelated.txt"), "keep");
    const fresh = host.begin("owner", 1);
    fresh.append("fresh");
    fresh.finish(true);
    expect((await host.read({ sessionId: "owner", reference: oldReference })).status).toBe("unavailable");
    expect(readFileSync(join(path, "unrelated.txt"), "utf8")).toBe("keep");

    const linked = host.begin("owner", 1);
    linked.append("linked");
    const linkedReference = linked.finish(true).reference!;
    const linkedId = linkedReference.slice("shell-output://".length);
    const linkedPath = join(path, `${linkedId}.log`);
    const target = join(path, "unrelated.txt");
    rmSync(linkedPath);
    try { symlinkSync(target, linkedPath); } catch { return; }
    expect((await host.read({ sessionId: "owner", reference: linkedReference })).status).toBe("unavailable");
  });

  it("keeps an active log readable even when its creation time is older than the TTL", async () => {
    const path = directory();
    const host = createShellOutputLogHost({ directory: path });
    const capture = host.begin("owner", 1);
    capture.append("active");
    const id = readdirSync(path).find((name) => name.endsWith(".log"))!.slice(0, -4);
    const metadataPath = join(path, `${id}.json`);
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    metadata.createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    writeFileSync(metadataPath, JSON.stringify(metadata));
    expect((await host.read({ sessionId: "owner", reference: `shell-output://${id}` })).status).toBe("ok");
    capture.finish(false);
  });

  it("expires a stale capture left unfinished by a previous host process", async () => {
    const path = directory();
    const host = createShellOutputLogHost({ directory: path });
    const capture = host.begin("owner", 1);
    capture.append("partial");
    const reference = capture.finish(false).reference!;
    const id = reference.slice("shell-output://".length);
    const metadataPath = join(path, `${id}.json`);
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    metadata.finished = false;
    metadata.createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    writeFileSync(metadataPath, JSON.stringify(metadata));
    const fresh = host.begin("owner", 1);
    fresh.append("fresh");
    fresh.finish(true);
    expect((await host.read({ sessionId: "owner", reference })).status).toBe("unavailable");
    expect(readdirSync(path)).not.toContain(`${id}.log`);
  });

  it("searches actual regex matches with byte positions and reports invalid regex", async () => {
    const host = createShellOutputLogHost({ directory: directory() });
    const capture = host.begin("owner", 1);
    capture.append("start-" + "x".repeat(10000) + "-Needle42-end");
    const reference = capture.finish(true).reference!;
    const result = await host.search({ sessionId: "owner", reference, pattern: "Needle[0-9]+" });
    expect(result).toMatchObject({ status: "ok", matches: [{ byteOffset: 10007, text: "Needle42" }] });
    expect((await host.search({ sessionId: "owner", reference, pattern: "[" })).status).toBe("invalid_pattern");
    expect((await host.search({ sessionId: "owner", reference, pattern: "\0" })).status).toBe("invalid_pattern");
  });

  it("reports a search limit when there are more than 200 matches", async () => {
    const host = createShellOutputLogHost({ directory: directory() });
    const capture = host.begin("owner", 1);
    capture.append("a\n".repeat(201));
    const result = await host.search({ sessionId: "owner", reference: capture.finish(true).reference!, pattern: "a" });
    expect(result).toMatchObject({ status: "limit", truncated: true });
    expect(result.matches).toHaveLength(200);
  });

  it("reports a search limit when one regex match exceeds the process output budget", async () => {
    const host = createShellOutputLogHost({ directory: directory() });
    const capture = host.begin("owner", 1);
    capture.append("x".repeat(40 * 1024));
    const result = await host.search({ sessionId: "owner", reference: capture.finish(true).reference!, pattern: "x+" });
    expect(result).toMatchObject({ status: "limit", truncated: true });
  });

  it("does not throw into the command when the managed log becomes unwritable", async () => {
    const path = directory();
    const host = createShellOutputLogHost({ directory: path });
    const capture = host.begin("owner", 1);
    capture.append("first");
    const log = readdirSync(path).find((name) => name.endsWith(".log"))!;
    rmSync(join(path, log));
    mkdirSync(join(path, log));
    expect(() => capture.append("second")).not.toThrow();
    expect(capture.finish(true)).toMatchObject({ available: false, complete: false, reason: "log write failed" });
    expect(capture.finish(true)).toEqual(capture.finish(false));
  });

  it("does not follow a linked managed directory or authorize a log without metadata", async () => {
    const path = directory();
    const host = createShellOutputLogHost({ directory: path });
    const capture = host.begin("owner", 1);
    capture.append("content");
    const reference = capture.finish(true).reference!;
    const id = reference.slice("shell-output://".length);
    rmSync(join(path, `${id}.json`));
    expect((await host.read({ sessionId: "owner", reference })).status).toBe("unavailable");

    const target = join(path, "target");
    const linked = join(path, "linked");
    mkdirSync(target);
    try { symlinkSync(target, linked, "junction"); } catch { return; }
    const linkedHost = createShellOutputLogHost({ directory: linked });
    const denied = linkedHost.begin("owner", 1);
    expect(() => denied.append("content")).not.toThrow();
    expect(denied.finish(true).available).toBe(false);
    expect(readdirSync(target)).toEqual([]);
  });

  it("never writes through a managed directory replaced by a junction after capture begins", () => {
    const root = directory();
    const managed = join(root, "managed");
    mkdirSync(managed);
    const host = createShellOutputLogHost({ directory: managed });
    const capture = host.begin("owner", 1);
    capture.append("first");
    const id = readdirSync(managed).find((name) => name.endsWith(".log"))!.slice(0, -4);
    const external = join(root, "external");
    mkdirSync(external);
    copyFileSync(join(managed, `${id}.log`), join(external, `${id}.log`));
    copyFileSync(join(managed, `${id}.json`), join(external, `${id}.json`));
    const beforeLog = readFileSync(join(external, `${id}.log`), "utf8");
    const beforeMetadata = readFileSync(join(external, `${id}.json`), "utf8");
    renameSync(managed, join(root, "parked"));
    symlinkSync(external, managed, "junction");
    expect(() => capture.append("second")).not.toThrow();
    expect(capture.finish(true)).toMatchObject({ available: false, complete: false });
    expect(readFileSync(join(external, `${id}.log`), "utf8")).toBe(beforeLog);
    expect(readFileSync(join(external, `${id}.json`), "utf8")).toBe(beforeMetadata);
  });

  it("finds regex matches on both sides of NUL bytes", async () => {
    const host = createShellOutputLogHost({ directory: directory() });
    const capture = host.begin("owner", 1);
    capture.append("before\0Needle42-after\0Needle43");
    const result = await host.search({ sessionId: "owner", reference: capture.finish(true).reference!, pattern: "Needle[0-9]+" });
    expect(result).toMatchObject({ status: "ok", matches: [
      { byteOffset: 7, text: "Needle42" },
      { byteOffset: 22, text: "Needle43" },
    ] });
  });

  it("does not call a finished log complete when its persisted length no longer matches metadata", async () => {
    const path = directory();
    const host = createShellOutputLogHost({ directory: path });
    const capture = host.begin("owner", 1);
    capture.append("stable");
    const reference = capture.finish(true).reference!;
    const id = reference.slice("shell-output://".length);
    writeFileSync(join(path, `${id}.log`), "different");
    expect((await host.read({ sessionId: "owner", reference })).status).toBe("unavailable");
  });
});

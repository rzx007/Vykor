import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileReadTool } from "../read.js";
import { fileWriteTool } from "../write.js";
import { FileNotFoundError, HostFileOperations, WslFileOperations } from "../operations.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("file operations", () => {
  it("reads and writes native workspace files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vk-files-")); roots.push(cwd);
    const file = join(cwd, "note.txt");
    await fileWriteTool.execute!({ file_path: file, content: "hello" }, { cwd });
    const readResult = await fileReadTool.execute!({ file_path: file }, { cwd });
    expect(readResult.isError).toBeFalsy();
    expect((readResult.content[0] as { text: string }).text).toBe(
      "1: hello\n\n(End of file - total 1 lines)",
    );
    expect(await readFile(file, "utf8")).toBe("hello");
  });

  it("uses the environment executor for WSL POSIX paths", async () => {
    const calls: string[][] = [];
    const operations = new WslFileOperations({
      info: { kind: "wsl" }, workspace: { executionRoot: "/mnt/d/repo" },
      process: { execProcess: async (argv: string[]) => { calls.push(argv); return environmentProcess("hello"); } },
    } as any);
    await expect(operations.readText("/home/me/file.txt")).resolves.toBe("hello");
    expect(calls[0]?.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(calls[0]?.slice(-2)).toEqual(["vk-read", "/home/me/file.txt"]);
  });
});

describe("atomic host file operations", () => {
  it("creates a new file exclusively and creates parent directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "vk-atomic-create-"));
    roots.push(root);
    const file = join(root, "nested", "new.txt");
    const operations = new HostFileOperations();

    await operations.createTextExclusive(file, "first");
    await expect(operations.createTextExclusive(file, "second")).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("first");
  });

  it("atomically replaces an existing host file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vk-atomic-replace-"));
    roots.push(root);
    const file = join(root, "value.txt");
    const operations = new HostFileOperations();
    await writeFile(file, "old", "utf8");

    await operations.writeTextAtomic(file, "new");
    expect(await readFile(file, "utf8")).toBe("new");
    expect((await readdir(root)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("handles a legal long basename without lengthening its temporary name", async () => {
    const root = await mkdtemp(join(tmpdir(), "vk-long-basename-"));
    roots.push(root);
    const file = join(root, `${"x".repeat(220)}.txt`);
    const operations = new HostFileOperations();

    await operations.createTextExclusive(file, "first");
    await operations.writeTextAtomic(file, "second");
    expect(await readFile(file, "utf8")).toBe("second");
  });

  it.skipIf(process.platform === "win32")("keeps an existing file's mode during atomic replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "vk-atomic-mode-"));
    roots.push(root);
    const file = join(root, "script.sh");
    const operations = new HostFileOperations();
    await writeFile(file, "old", "utf8");
    await chmod(file, 0o755);

    await operations.writeTextAtomic(file, "new");
    expect((await stat(file)).mode & 0o777).toBe(0o755);
  });

  it("marks host symbolic links so mutation tools can reject them", async () => {
    const root = await mkdtemp(join(tmpdir(), "vk-link-stat-"));
    roots.push(root);
    const file = join(root, "real.txt");
    const link = join(root, "link.txt");
    await writeFile(file, "content", "utf8");
    try {
      await symlink(file, link, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    expect(await new HostFileOperations().stat(link)).toMatchObject({ isFile: true, isSymbolicLink: true });
    await expect(new HostFileOperations().removeFile(link)).rejects.toThrow();
    expect(await readFile(link, "utf8")).toBe("content");
  });

  it("removes a file but refuses a directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "vk-remove-file-"));
    roots.push(root);
    const file = join(root, "gone.txt");
    const operations = new HostFileOperations();
    await writeFile(file, "x", "utf8");

    await operations.removeFile(file);
    await expect(readFile(file)).rejects.toThrow();
    await expect(operations.removeFile(root)).rejects.toThrow();
  });
});

describe("FileNotFoundError mapping", () => {
  it("maps a missing host path to FileNotFoundError", async () => {
    const root = await mkdtemp(join(tmpdir(), "vk-enoent-"));
    roots.push(root);
    const operations = new HostFileOperations();
    const missing = join(root, "absent.txt");

    await expect(operations.stat(missing)).rejects.toBeInstanceOf(FileNotFoundError);
    await expect(operations.readBytes(missing)).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it("does not map non-ENOENT host errors to FileNotFoundError", async () => {
    const root = await mkdtemp(join(tmpdir(), "vk-notdir-"));
    roots.push(root);
    const operations = new HostFileOperations();

    const error = await operations.readBytes(root).catch((value) => value);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(FileNotFoundError);
  });

  it("maps the WSL missing-path exit branch to FileNotFoundError", async () => {
    const operations = new WslFileOperations(wslEnvironment(async () => environmentExit(2)) as any);
    await expect(operations.stat("/home/me/missing")).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it("does not map other WSL stat failures to FileNotFoundError", async () => {
    const operations = new WslFileOperations(wslEnvironment(async () => environmentExit(1)) as any);
    const error = await operations.stat("/home/me/denied").catch((value) => value);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(FileNotFoundError);
  });

  it("maps the WSL read missing-path exit branch to FileNotFoundError", async () => {
    const operations = new WslFileOperations(wslEnvironment(async () => environmentExit(3)) as any);
    await expect(operations.readBytes("/home/me/missing")).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it("does not classify the WSL permission branch as missing", async () => {
    const operations = new WslFileOperations(wslEnvironment(async () => environmentExit(13)) as any);
    const statError = await operations.stat("/home/me/denied").catch((value) => value);
    const readError = await operations.readBytes("/home/me/denied").catch((value) => value);
    expect(statError).not.toBeInstanceOf(FileNotFoundError);
    expect(readError).not.toBeInstanceOf(FileNotFoundError);
  });

  it("marks a WSL symbolic link to a file", async () => {
    const operations = new WslFileOperations(wslEnvironment(async () => environmentProcess("symlink-file")) as any);
    await expect(operations.stat("/home/me/link.txt")).resolves.toMatchObject({
      isFile: true,
      isSymbolicLink: true,
    });
  });

  it.skipIf(process.platform === "win32" && !existsSync("C:/Program Files/Git/bin/sh.exe"))(
    "recognizes a missing target under a missing parent with a searchable ancestor",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "vk-wsl-nested-missing-"));
      roots.push(root);
      const target = join(root, "new", "deep", "file.txt").replaceAll("\\", "/");
      const shell = process.platform === "win32" ? "C:/Program Files/Git/bin/sh.exe" : "/bin/sh";
      const operations = new WslFileOperations(
        wslEnvironment(async (argv) => {
          const result = spawnSync(shell, argv.slice(1), { encoding: "utf8" });
          if (result.error) throw result.error;
          return environmentExit(result.status ?? 1);
        }) as any,
      );
      await expect(operations.stat(target)).rejects.toBeInstanceOf(FileNotFoundError);
      await expect(operations.readBytes(target)).rejects.toBeInstanceOf(FileNotFoundError);
    },
  );
});

describe("atomic WSL file operations", () => {
  it("passes write paths as positional arguments without shell injection", async () => {
    const calls: string[][] = [];
    const hostile = "/tmp/a;touch-pwned.txt";
    const operations = new WslFileOperations(
      wslEnvironment(async (argv) => { calls.push(argv); return environmentExit(0); }) as any,
    );

    await operations.createTextExclusive(hostile, "body");
    expect(calls.at(-1)?.slice(-2)).toEqual(["vk-exclusive", hostile]);
    expect(calls.at(-1)?.[2]).not.toContain("touch-pwned");

    await operations.writeTextAtomic(hostile, "body");
    expect(calls.at(-1)?.slice(-2)).toEqual(["vk-atomic", hostile]);
    expect(calls.at(-1)?.[2]).not.toContain("touch-pwned");

    await operations.removeFile(hostile);
    expect(calls.at(-1)?.slice(-2)).toEqual(["vk-remove", hostile]);
    expect(calls.at(-1)?.[2]).not.toContain("touch-pwned");
  });

  it("preserves the target mode before publishing an atomic WSL replacement", async () => {
    const calls: string[][] = [];
    const operations = new WslFileOperations(
      wslEnvironment(async (argv) => { calls.push(argv); return environmentExit(0); }) as any,
    );
    await operations.writeTextAtomic("/tmp/script.sh", "new");
    expect(calls[0]?.[2]).toContain('chmod --reference="$target" -- "$tmp"');
    expect(calls[0]?.slice(-2)).toEqual(["vk-atomic", "/tmp/script.sh"]);
  });

  it.skipIf(process.platform === "win32" && !existsSync("C:/Program Files/Git/bin/sh.exe"))(
    "does not move an atomic replacement inside a concurrently created directory",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "vk-wsl-atomic-dir-"));
      roots.push(root);
      const target = join(root, "occupied");
      await mkdir(target);
      const shell = process.platform === "win32" ? "C:/Program Files/Git/bin/sh.exe" : "/bin/sh";
      const operations = new WslFileOperations(
        wslEnvironment(async (argv) => {
          const input: Buffer[] = [];
          let status = 1;
          return {
            write(data: string | Uint8Array) { input.push(Buffer.from(data)); },
            end() {
              const result = spawnSync(shell, argv.slice(1), {
                input: Buffer.concat(input),
                encoding: "utf8",
              });
              if (result.error) throw result.error;
              status = result.status ?? 1;
            },
            onOutput() { return () => {}; },
            onErrorOutput() { return () => {}; },
            async wait() { return { exitCode: status }; },
          };
        }) as any,
      );

      await expect(operations.writeTextAtomic(target.replaceAll("\\", "/"), "new"))
        .rejects.toThrow();
      expect(await readdir(target)).toEqual([]);
    },
  );

  it("rejects a WSL exclusive create when the fixed script reports failure", async () => {
    const operations = new WslFileOperations(wslEnvironment(async () => environmentExit(1)) as any);
    await expect(operations.createTextExclusive("/tmp/existing.txt", "body")).rejects.toThrow();
  });

  it("rejects a WSL remove when the fixed script reports a non-file path", async () => {
    const operations = new WslFileOperations(wslEnvironment(async () => environmentExit(4)) as any);
    await expect(operations.removeFile("/tmp/adir")).rejects.toThrow();
  });
});

function wslEnvironment(exec: (argv: string[]) => Promise<ReturnType<typeof environmentExit>>) {
  return {
    info: { kind: "wsl" },
    workspace: { executionRoot: "/mnt/d/repo" },
    process: { execProcess: exec },
  };
}

function environmentProcess(output: string) {
  return { write() {}, end() {}, onOutput(listener: (chunk: Uint8Array) => void) { listener(Buffer.from(output)); return () => {}; }, async wait() { return { exitCode: 0 }; }, async signal() {} };
}

function environmentExit(exitCode: number) {
  return { write() {}, end() {}, onOutput() { return () => {}; }, async wait() { return { exitCode }; }, async signal() {} };
}

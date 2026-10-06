import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createGitRunChangeInspector,
  createExecFileGitExecutor,
  type GitExecutor,
  type GitRunBaseline,
  type GitRunChangeSet,
  type GitRunResult,
} from "./git-run-change-inspector.js";

const NUL = Buffer.from([0]);

function ok(value: string | Buffer): GitRunResult {
  return {
    stdout: typeof value === "string" ? Buffer.from(value, "utf8") : value,
    stderr: "",
    code: 0,
  };
}

function bad(code = 128): GitRunResult {
  return { stdout: Buffer.alloc(0), stderr: "git failed", code };
}

function statusRecord(xy: string, path: string, oldPath?: string): Buffer {
  const parts = [Buffer.from(`${xy} ${path}`, "utf8"), NUL];
  if (oldPath !== undefined) parts.push(Buffer.from(oldPath, "utf8"), NUL);
  return Buffer.concat(parts);
}

interface FakeConfig {
  root?: string;
  head?: string;
  status?: Buffer;
  index?: Buffer;
  worktree?: Record<string, string | "missing">;
  nameStatus?: Buffer;
  numstat?: Buffer;
  patch?: string;
  ancestor?: boolean;
  onExec?: (args: string[]) => GitRunResult | undefined;
}

function fakeExecutor(config: FakeConfig): GitExecutor {
  return {
    async exec(args) {
      const override = config.onExec?.(args);
      if (override) return override;
      const command = args[0];
      if (command === "rev-parse" && args[1] === "--show-toplevel") {
        return config.root === undefined ? bad() : ok(`${config.root}\n`);
      }
      if (command === "rev-parse" && args[1] === "HEAD") {
        return config.head === undefined ? bad() : ok(`${config.head}\n`);
      }
      if (command === "status") return ok(config.status ?? Buffer.alloc(0));
      if (command === "ls-files") return ok(config.index ?? Buffer.alloc(0));
      if (command === "hash-object") {
        const path = args[args.length - 1]!;
        const value = config.worktree?.[path];
        return value === undefined || value === "missing" ? bad() : ok(`${value}\n`);
      }
      if (command === "diff" && args.includes("--name-status")) {
        return ok(config.nameStatus ?? Buffer.alloc(0));
      }
      if (command === "diff" && args.includes("--numstat")) {
        return ok(config.numstat ?? Buffer.alloc(0));
      }
      if (command === "diff" && args.includes("--no-index")) {
        return { stdout: Buffer.from(config.patch ?? "", "utf8"), stderr: "", code: 1 };
      }
      if (command === "diff") {
        return { stdout: Buffer.from(config.patch ?? "", "utf8"), stderr: "", code: 0 };
      }
      if (command === "merge-base") return config.ancestor === false ? bad(1) : ok("");
      return bad();
    },
  };
}

const FAKE_HASH_A = "a".repeat(40);
const FAKE_HASH_B = "b".repeat(40);

describe("git run change inspector (real repositories)", () => {
  let repo: string;

  function git(args: string[]): string {
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  function write(relativePath: string, content: string): void {
    const fullPath = join(repo, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf8");
  }

  function commit(message: string): void {
    git(["add", "-A"]);
    git(["commit", "-q", "-m", message]);
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "vykor-git-change-"));
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    git(["config", "core.autocrlf", "false"]);
    git(["config", "commit.gpgsign", "false"]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("cancels a real Git process waiting on stdin and closes it before returning", async () => {
    const controller = new AbortController();
    const pending = createExecFileGitExecutor().exec(["hash-object", "--stdin"], repo, controller.signal);
    const timer = setTimeout(() => controller.abort(), 50);
    try { await expect(pending).rejects.toMatchObject({ name: "AbortError" }); }
    finally { clearTimeout(timer); }
  });

  it("attributes newly modified and untracked files to the run", async () => {
    write("packages/x.ts", "export const x = 1;\n");
    commit("init");

    const inspector = createGitRunChangeInspector();
    const baseline = (await inspector.capture(repo)) as GitRunBaseline;
    expect(typeof baseline.head).toBe("string");

    write("packages/x.ts", "export const x = 2;\n");
    write("packages/y.ts", "export const y = 1;\n");

    const delta = (await inspector.compare(repo, baseline)) as GitRunChangeSet;

    expect(delta).toMatchObject({ attribution: "complete", patchTruncated: false });
    expect(delta.baseHead).toBe(baseline.head);
    expect(delta.head).toBe(baseline.head);
    expect(delta.files).toEqual([
      { path: "packages/x.ts", status: "modified", lines: expect.any(Number) },
      { path: "packages/y.ts", status: "added", lines: expect.any(Number) },
    ]);
    expect(delta.patch).toContain("diff --git");
  });

  it("attributes an untracked file named __proto__", async () => {
    write("base.txt", "base\n");
    commit("init");
    const inspector = createGitRunChangeInspector();
    const baseline = (await inspector.capture(repo)) as GitRunBaseline;
    write("__proto__", "new file\n");

    const delta = await inspector.compare(repo, baseline);
    expect(delta).toMatchObject({ attribution: "complete" });
    expect((delta as GitRunChangeSet).files).toEqual([
      { path: "__proto__", status: "added", lines: expect.any(Number) },
    ]);
  });

  it("does not include an existing dirty sibling through a Git glob pathspec", async () => {
    write("a[1].txt", "target before\n");
    write("a1.txt", "sibling before\n");
    commit("init");
    write("a1.txt", "PREEXISTING_SIBLING_BODY\n");
    const inspector = createGitRunChangeInspector();
    const baseline = await inspector.capture(repo) as GitRunBaseline;
    expect(baseline.repositoryRoot).toBe(git(["rev-parse", "--show-toplevel"]).trim());
    write("a[1].txt", "TARGET_CHANGED_BODY\n");
    const changes = await inspector.compare(repo, baseline) as GitRunChangeSet;
    expect(changes.files.map(file => file.path)).toEqual(["a[1].txt"]);
    expect(changes.patch).toContain("TARGET_CHANGED_BODY");
    expect(changes.patch).not.toContain("PREEXISTING_SIBLING_BODY");
  });

  it.each([".env", "private.pem", ".npmrc"])(
    "does not send the contents of %s to the reviewer",
    async (path) => {
      write("base.txt", "base\n");
      commit("init");
      const inspector = createGitRunChangeInspector();
      const baseline = (await inspector.capture(repo)) as GitRunBaseline;
      write(path, "DO_NOT_SEND_THIS_SECRET\n");

      const delta = await inspector.compare(repo, baseline);
      expect(delta).toEqual({ attribution: "unavailable", reason: "sensitive_content_path" });
    },
  );

  it("rejects a committed secret change before building its patch", async () => {
    write("private.pem", "OLD_SECRET\n");
    commit("init");
    const inspector = createGitRunChangeInspector();
    const baseline = (await inspector.capture(repo)) as GitRunBaseline;
    write("private.pem", "NEW_SECRET\n");
    commit("rotate key");

    expect(await inspector.compare(repo, baseline)).toEqual({
      attribution: "unavailable",
      reason: "sensitive_content_path",
    });
  });

  it("checks the old path when a secret file is renamed to a normal source path", async () => {
    write(".env", "DO_NOT_SEND_THIS_SECRET\n");
    commit("init");
    const inspector = createGitRunChangeInspector();
    const baseline = (await inspector.capture(repo)) as GitRunBaseline;
    git(["mv", ".env", "config.ts"]);
    expect(await inspector.compare(repo, baseline)).toEqual({
      attribution: "unavailable", reason: "sensitive_content_path",
    });
  });

  it("reviews only new dirty paths when the baseline already had other dirty files", async () => {
    write("a.txt", "a\n");
    write("b.txt", "b\n");
    commit("init");

    write("a.txt", "a2\n");
    const inspector = createGitRunChangeInspector();
    const baseline = (await inspector.capture(repo)) as GitRunBaseline;

    write("b.txt", "b2\n");
    const delta = (await inspector.compare(repo, baseline)) as GitRunChangeSet;

    expect(delta.attribution).toBe("complete");
    expect(delta.files).toEqual([
      { path: "b.txt", status: "modified", lines: expect.any(Number) },
    ]);
  });

  it("refuses to review when a pre-existing dirty file changed again", async () => {
    write("a.txt", "a\n");
    commit("init");
    write("a.txt", "a2\n");

    const inspector = createGitRunChangeInspector();
    const baseline = (await inspector.capture(repo)) as GitRunBaseline;

    write("a.txt", "a3\n");
    const result = await inspector.compare(repo, baseline);

    expect(result).toEqual({ attribution: "unavailable", reason: "preexisting_dirty_overlap" });
  });

  it("reviews a linear commit range", async () => {
    write("packages/x.ts", "one\n");
    commit("init");

    const inspector = createGitRunChangeInspector();
    const baseline = (await inspector.capture(repo)) as GitRunBaseline;

    write("packages/x.ts", "two\n");
    commit("change");

    const delta = (await inspector.compare(repo, baseline)) as GitRunChangeSet;

    expect(delta).toMatchObject({ attribution: "complete", baseHead: baseline.head });
    expect(delta.head).not.toBe(delta.baseHead);
    expect(delta.files).toEqual([
      { path: "packages/x.ts", status: "modified", lines: expect.any(Number) },
    ]);
  });

  it("refuses a non-linear head change", async () => {
    write("a.txt", "a\n");
    commit("init");

    const inspector = createGitRunChangeInspector();
    const baseline = (await inspector.capture(repo)) as GitRunBaseline;

    git(["checkout", "-q", "--orphan", "other"]);
    commit("orphan root");

    const result = await inspector.compare(repo, baseline);

    expect(result).toEqual({ attribution: "unavailable", reason: "non_linear_head_change" });
  });

  it("refuses a commit range review when extra worktree changes appeared after the commit", async () => {
    write("packages/x.ts", "one\n");
    commit("init");

    const inspector = createGitRunChangeInspector();
    const baseline = (await inspector.capture(repo)) as GitRunBaseline;

    write("packages/x.ts", "two\n");
    commit("change");
    write("packages/y.ts", "extra\n");

    const result = await inspector.compare(repo, baseline);

    expect(result).toEqual({ attribution: "unavailable", reason: "post_commit_worktree_changed" });
  });

  it("reports renames and deletions with both paths", async () => {
    write("a.txt", "a\n");
    write("b.txt", "b\n");
    commit("init");

    const inspector = createGitRunChangeInspector();
    const baseline = (await inspector.capture(repo)) as GitRunBaseline;

    git(["mv", "a.txt", "renamed.txt"]);
    git(["rm", "-q", "b.txt"]);

    const delta = (await inspector.compare(repo, baseline)) as GitRunChangeSet;

    expect(delta.files).toEqual([
      { path: "b.txt", status: "deleted", lines: expect.any(Number) },
      { path: "renamed.txt", oldPath: "a.txt", status: "renamed", lines: expect.any(Number) },
    ]);
  });

  it("preserves paths that contain spaces", async () => {
    write("docs/my file.md", "a\n");
    commit("init");

    const inspector = createGitRunChangeInspector();
    const baseline = (await inspector.capture(repo)) as GitRunBaseline;

    write("docs/my file.md", "b\n");
    const delta = (await inspector.compare(repo, baseline)) as GitRunChangeSet;

    expect(delta.files).toEqual([
      { path: "docs/my file.md", status: "modified", lines: expect.any(Number) },
    ]);
  });

  it("marks a patch that exceeds the bounded size as truncated", async () => {
    write("a.txt", "a\n");
    commit("init");

    const inspector = createGitRunChangeInspector();
    const baseline = (await inspector.capture(repo)) as GitRunBaseline;

    write("big.txt", `${"a".repeat(600_000)}\n`);
    const delta = (await inspector.compare(repo, baseline)) as GitRunChangeSet;

    expect(delta.patchTruncated).toBe(true);
  });

  it("reports an empty change set when nothing changed", async () => {
    write("a.txt", "a\n");
    commit("init");

    const inspector = createGitRunChangeInspector();
    const baseline = (await inspector.capture(repo)) as GitRunBaseline;
    const delta = (await inspector.compare(repo, baseline)) as GitRunChangeSet;

    expect(delta).toMatchObject({ attribution: "complete", patch: "", patchTruncated: false });
    expect(delta.files).toEqual([]);
  });
});

describe("git run change inspector (injected executor)", () => {
  it.each([String.raw`/work/repo\name`, "/work/repo ", "/work/ repo "])("uses the exact Git-returned repository root for later commands: %s", async (root) => {
    const delegate = fakeExecutor({ root, head: "a" });
    const inspector = createGitRunChangeInspector({
      exec: async (args, cwd) => cwd === root ? delegate.exec(args, cwd) : bad(),
    });
    const baseline = await inspector.capture(root);
    expect(baseline).toEqual({ repositoryRoot: root, head: "a", dirty: {} });
    expect(await inspector.compare(root, baseline as GitRunBaseline)).toMatchObject({ attribution: "complete", files: [] });
  });

  it("hashes the literal path returned by Git instead of a slash-named sibling", async () => {
    const path = String.raw`dir\a.txt`;
    const inspector = createGitRunChangeInspector(fakeExecutor({
      root: "/repo", head: "a", status: statusRecord("??", path),
      worktree: { [path]: FAKE_HASH_A, "dir/a.txt": FAKE_HASH_B },
    }));
    const baseline = await inspector.capture("/repo") as GitRunBaseline;
    expect(baseline.dirty[path]?.worktreeHash).toBe(FAKE_HASH_A);
  });

  it("preserves literal backslashes in Git rename identities", async () => {
    const config: FakeConfig = { root: "/repo", head: "a" };
    const inspector = createGitRunChangeInspector(fakeExecutor(config));
    const baseline = await inspector.capture("/repo") as GitRunBaseline;
    const oldPath = String.raw`old\name.txt`;
    const path = String.raw`new\name.txt`;
    config.status = statusRecord("R ", path, oldPath);
    config.worktree = { [path]: FAKE_HASH_A };
    config.nameStatus = Buffer.from(`R100\0${oldPath}\0${path}\0`);
    config.numstat = Buffer.from(`1\t1\t${path}\0`);
    const changes = await inspector.compare("/repo", baseline) as GitRunChangeSet;
    expect(changes.files).toEqual([{ path, oldPath, status: "renamed", lines: 2 }]);
  });

  it("reports a non-git workspace without falling back to a full diff", async () => {
    const inspector = createGitRunChangeInspector(fakeExecutor({}));
    expect(await inspector.capture("/repo")).toEqual({
      attribution: "unavailable",
      reason: "not_git_repository",
    });
  });

  it("fails closed when the head changes during capture", async () => {
    const heads = ["a", "b"];
    let reads = 0;
    const inspector = createGitRunChangeInspector(
      fakeExecutor({
        root: "/repo",
        onExec: (args) =>
          args[0] === "rev-parse" && args[1] === "HEAD"
            ? ok(`${heads[Math.min(reads++, heads.length - 1)]}\n`)
            : undefined,
      }),
    );

    expect(await inspector.capture("/repo")).toEqual({
      attribution: "unavailable",
      reason: "git_inspection_failed",
    });
  });

  it("treats an index-only change on a pre-existing dirty path as overlap", async () => {
    const config: FakeConfig = {
      root: "/repo",
      head: "a",
      status: statusRecord(" M", "a.txt"),
      index: Buffer.concat([Buffer.from(`100644 ${FAKE_HASH_A} 0\ta.txt`, "utf8"), NUL]),
      worktree: { "a.txt": FAKE_HASH_B },
    };
    const inspector = createGitRunChangeInspector(fakeExecutor(config));
    const baseline = (await inspector.capture("/repo")) as GitRunBaseline;

    config.index = Buffer.concat([Buffer.from(`100644 ${"c".repeat(40)} 0\ta.txt`, "utf8"), NUL]);

    expect(await inspector.compare("/repo", baseline)).toEqual({
      attribution: "unavailable",
      reason: "preexisting_dirty_overlap",
    });
  });

  it("treats a symlink path as unavailable", async () => {
    const inspector = createGitRunChangeInspector(
      fakeExecutor({
        root: "/repo",
        head: "a",
        status: statusRecord(" M", "link"),
        index: Buffer.concat([Buffer.from(`120000 ${FAKE_HASH_A} 0\tlink`, "utf8"), NUL]),
      }),
    );

    expect(await inspector.capture("/repo")).toEqual({
      attribution: "unavailable",
      reason: "git_inspection_failed",
    });
  });

  it("treats a submodule path as unavailable", async () => {
    const inspector = createGitRunChangeInspector(
      fakeExecutor({
        root: "/repo",
        head: "a",
        status: statusRecord(" M", "vendor/dep"),
        index: Buffer.concat([Buffer.from(`160000 ${FAKE_HASH_A} 0\tvendor/dep`, "utf8"), NUL]),
      }),
    );

    expect(await inspector.capture("/repo")).toEqual({
      attribution: "unavailable",
      reason: "git_inspection_failed",
    });
  });

  it("rejects paths that are not valid UTF-8", async () => {
    const inspector = createGitRunChangeInspector(
      fakeExecutor({
        root: "/repo",
        head: "a",
        status: Buffer.concat([Buffer.from("?? ", "latin1"), Buffer.from([0x80, 0x81]), NUL]),
      }),
    );

    expect(await inspector.capture("/repo")).toEqual({
      attribution: "unavailable",
      reason: "git_inspection_failed",
    });
  });

  it("rejects paths that contain control characters", async () => {
    const inspector = createGitRunChangeInspector(
      fakeExecutor({
        root: "/repo",
        head: "a",
        status: statusRecord("??", "bad\u0001name"),
      }),
    );

    expect(await inspector.capture("/repo")).toEqual({
      attribution: "unavailable",
      reason: "git_inspection_failed",
    });
  });

  it("attributes an injected linear commit with stable heads", async () => {
    const config: FakeConfig = {
      root: "/repo",
      head: "a",
      nameStatus: Buffer.from("M\0packages/x.ts\0", "utf8"),
      numstat: Buffer.from("1\t1\tpackages/x.ts\0", "utf8"),
      patch: "diff --git a/packages/x.ts b/packages/x.ts\n",
      ancestor: true,
    };
    const inspector = createGitRunChangeInspector(fakeExecutor(config));
    const baseline = (await inspector.capture("/repo")) as GitRunBaseline;

    config.head = "b";
    const delta = (await inspector.compare("/repo", baseline)) as GitRunChangeSet;

    expect(delta).toMatchObject({
      attribution: "complete",
      baseHead: "a",
      head: "b",
      files: [{ path: "packages/x.ts", status: "modified" }],
      patchTruncated: false,
    });
  });
});

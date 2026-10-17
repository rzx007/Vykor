import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { withFiles } from "../tools/file-access.mjs";
import { recoverAbandonedLock } from "../tools/lock-recovery.mjs";
const ctx = () => ({
  signal: new AbortController().signal,
  deadline: Date.now() + 30000,
});
const owner = (file) => ({
  version: 1,
  file,
  pid: 2147483647,
  host: hostname(),
  token: randomUUID(),
});
const fixture = async (ext) => {
  const dir = await mkdtemp(join(tmpdir(), "office-restart-")),
    file = join(dir, "report." + ext),
    record = owner(file);
  await writeFile(file, "source unchanged");
  await writeFile(file + ".office-work.lock", JSON.stringify(record));
  const temp = join(dir, ".office-work-dead");
  await (await import("node:fs/promises")).mkdir(temp);
  await writeFile(
    join(temp, ".office-work-owner.json"),
    JSON.stringify(record),
  );
  await writeFile(join(temp, "working." + ext), "private");
  return { dir, file, record, temp };
};
for (const ext of ["pptx", "docx", "xlsx"])
  test(`restart recovery closes only the registered abandoned ${ext} copy before taking its lock`, async () => {
    const f = await fixture(ext),
      calls = [];
    try {
      const recover = (file, context) =>
        recoverAbandonedLock(file, context, async (args) => calls.push(args));
      await withFiles(
        [f.file],
        ctx(),
        async () => {
          assert.equal(
            (await readdir(f.dir)).includes(".office-work-dead"),
            false,
          );
          const live = JSON.parse(
            await readFile(f.file + ".office-work.lock", "utf8"),
          );
          assert.equal(live.pid, process.pid);
          assert.notEqual(live.token, f.record.token);
        },
        recover,
      );
      assert.deepEqual(
        calls.map(([cmd, path]) => [cmd, lockKey(path)]),
        [["close", lockKey(join(f.temp, "working." + ext))]],
      );
      assert.equal(await readFile(f.file, "utf8"), "source unchanged");
      assert.deepEqual(await readdir(f.dir), ["report." + ext]);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
test("live owners, legacy empty locks and foreign-host locks are never reclaimed", async () => {
  const f = await fixture("xlsx");
  try {
    for (const record of [
      { ...f.record, pid: process.pid },
      { ...f.record, host: "other-host" },
      null,
    ]) {
      await writeFile(
        f.file + ".office-work.lock",
        record ? JSON.stringify(record) : "",
      );
      let closes = 0;
      await recoverAbandonedLock(f.file, ctx(), async () => closes++).catch(
        (e) => assert.equal(e.code, "office_recovery_required"),
      );
      assert.equal(closes, 0);
      assert.equal((await readdir(f.dir)).includes(".office-work-dead"), true);
      assert.equal(
        await readFile(f.file + ".office-work.lock", "utf8"),
        record ? JSON.stringify(record) : "",
      );
    }
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("failed close retains abandoned lock and private copy; concurrent recovery grants only one operation", async () => {
  const f = await fixture("xlsx");
  try {
    await assert.rejects(
      () =>
        recoverAbandonedLock(f.file, ctx(), async () => {
          throw new Error("close failed");
        }),
      /close failed/,
    );
    assert.ok(await readFile(f.file + ".office-work.lock"));
    assert.ok(await readFile(join(f.temp, "working.xlsx")));
    let active = 0,
      max = 0,
      closes = 0;
    const recover = (file, c) =>
      recoverAbandonedLock(file, c, async () => {
        closes++;
        await new Promise((r) => setTimeout(r, 20));
      });
    await Promise.all(
      [1, 2, 3].map(() =>
        withFiles(
          [f.file],
          ctx(),
          async () => {
            active++;
            max = Math.max(max, active);
            await new Promise((r) => setTimeout(r, 15));
            active--;
          },
          recover,
        ),
      ),
    );
    assert.equal(max, 1);
    assert.equal(closes, 1);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
import { fork } from "node:child_process";
import { once } from "node:events";
import { lockKey } from "../tools/lock-recovery.mjs";
test("killing an actual plugin worker preserves its lock until the next invocation safely recovers it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "office-real-restart-")),
    file = join(dir, "report.xlsx");
  let child;
  try {
    await writeFile(file, "user original");
    child = fork(
      new URL("./fixtures/locked-worker.mjs", import.meta.url),
      [file],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    const ready = await Promise.race([
      once(child, "message").then(([m]) => m),
      once(child, "exit").then(() => {
        throw new Error("worker exited before locking");
      }),
      new Promise((_, reject) => {
        const t = setTimeout(
          () => reject(new Error("worker startup timeout")),
          5000,
        );
        t.unref();
      }),
    ]);
    assert.equal(ready.ready, true);
    const record = JSON.parse(
      await readFile(file + ".office-work.lock", "utf8"),
    );
    assert.equal(record.pid, child.pid);
    const exiting = once(child, "exit");
    child.kill();
    await exiting;
    let closed = 0;
    await withFiles(
      [file],
      ctx(),
      async () => assert.equal(await readFile(file, "utf8"), "user original"),
      (f, c) =>
        recoverAbandonedLock(f, c, async (args) => {
          closed++;
          assert.equal(lockKey(args[1]), lockKey(ready.work));
        }),
    );
    assert.equal(closed, 1);
    assert.deepEqual(await readdir(dir), ["report.xlsx"]);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null)
      child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
import { recoverWorkingCopies } from "../tools/lock-recovery.mjs";
test("registered orphan copies can recover without a stale lock, while unrelated copies stay untouched", async () => {
  const f = await fixture("xlsx");
  try {
    await rm(f.file + ".office-work.lock");
    const unrelated = join(f.dir, ".office-work-other");
    await (await import("node:fs/promises")).mkdir(unrelated);
    await writeFile(
      join(unrelated, ".office-work-owner.json"),
      JSON.stringify({ ...f.record, file: join(f.dir, "other.xlsx") }),
    );
    await writeFile(join(unrelated, "working.xlsx"), "other copy");
    let closed = 0;
    await recoverWorkingCopies(f.file, ctx(), async () => closed++);
    assert.equal(closed, 1);
    assert.deepEqual((await readdir(f.dir)).sort(), [
      ".office-work-other",
      "report.xlsx",
    ]);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("unknown process permissions and abandoned recovery guards never authorize deletion", async () => {
  const f = await fixture("xlsx"),
    originalKill = process.kill;
  try {
    process.kill = (pid, signal) => {
      if (pid === f.record.pid)
        throw Object.assign(new Error("access denied"), { code: "EPERM" });
      return originalKill(pid, signal);
    };
    assert.equal(
      await recoverAbandonedLock(f.file, ctx(), async () =>
        assert.fail("must not close"),
      ),
      false,
    );
    assert.ok(await readFile(f.file + ".office-work.lock"));
    process.kill = originalKill;
    await writeFile(
      f.file + ".office-work.lock.recovery",
      JSON.stringify(f.record),
    );
    await assert.rejects(
      () =>
        recoverAbandonedLock(f.file, ctx(), async () =>
          assert.fail("must not close"),
        ),
      (e) => e.code === "office_recovery_required",
    );
    assert.ok(await readFile(join(f.temp, "working.xlsx")));
  } finally {
    process.kill = originalKill;
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("unregistered legacy directories are not swept while a registered dead owner is recovered", async () => {
  const f = await fixture("docx");
  try {
    const old = join(f.dir, ".office-work-legacy");
    await (await import("node:fs/promises")).mkdir(old);
    await writeFile(join(old, "working.docx"), "unregistered copy");
    await recoverAbandonedLock(f.file, ctx(), async () => {});
    assert.equal(
      await readFile(join(old, "working.docx"), "utf8"),
      "unregistered copy",
    );
    assert.equal(await readFile(f.file, "utf8"), "source unchanged");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("normal release never removes a replacement operation lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "office-lock-replaced-")),
    file = join(dir, "report.pptx"),
    replacement = { ...owner(file), pid: process.pid };
  try {
    await withFiles([file], ctx(), () =>
      writeFile(file + ".office-work.lock", JSON.stringify(replacement)),
    );
    assert.deepEqual(
      JSON.parse(await readFile(file + ".office-work.lock", "utf8")),
      replacement,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import {
  open,
  readFile,
  writeFile,
  readdir,
  realpath,
  lstat,
  rm,
} from "node:fs/promises";
import { join, dirname, resolve, extname } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { engine } from "./engine.mjs";

export const lockKey = (file) =>
  process.platform === "win32" ? resolve(file).toLowerCase() : resolve(file);
const active = new Map(),
  marker = ".office-work-owner.json";
const required = (message, temp) =>
  Object.assign(new Error(message), {
    code: "office_recovery_required",
    ...(temp ? { temporary_directory: temp } : {}),
  });
export function newLockOwner(file) {
  return {
    version: 1,
    file: lockKey(file),
    pid: process.pid,
    host: hostname(),
    token: randomUUID(),
  };
}
export function trackLock(file, owner) {
  if (owner) active.set(lockKey(file), owner);
  else active.delete(lockKey(file));
}
export async function markWorkingFile(file, temp) {
  const owner = active.get(lockKey(file)) ?? newLockOwner(file);
  await writeFile(join(temp, marker), JSON.stringify(owner), { flag: "wx" });
}
async function readOwner(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
      return null;
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT" || e instanceof SyntaxError) return null;
    throw e;
  }
}
const valid = (owner, file) =>
  owner?.version === 1 &&
  typeof owner.file === "string" &&
  lockKey(owner.file) === lockKey(file) &&
  Number.isSafeInteger(owner.pid) &&
  owner.pid > 0 &&
  owner.host === hostname() &&
  /^[a-f0-9-]{36}$/.test(owner.token ?? "");
// ESRCH alone proves the recorded process is gone. Reused PIDs, EPERM and
// unknown process states stay protected, irrespective of lock age.
function dead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === "ESRCH";
  }
}
const same = (a, b) =>
  a?.token === b?.token &&
  a?.pid === b?.pid &&
  a?.host === b?.host &&
  a?.file === b?.file;
export async function releaseLock(path, owner) {
  const current = await readOwner(path);
  if (same(current, owner)) await rm(path, { force: true });
}

// Also recover registered copies left after a prior cleanup error released its lock.
export async function recoverWorkingCopies(
  file,
  context,
  closeRun,
  expectedOwner,
) {
  const parent = dirname(file),
    directories = (await readdir(parent, { withFileTypes: true })).filter(
      (e) =>
        e.isDirectory() &&
        !e.isSymbolicLink() &&
        e.name.startsWith(".office-work-"),
    );
  let run = closeRun;
  for (const entry of directories) {
    const temp = join(parent, entry.name),
      registration = await readOwner(join(temp, marker));
    if (
      !valid(registration, file) ||
      !dead(registration.pid) ||
      (expectedOwner && !same(registration, expectedOwner))
    )
      continue;
    const owner = registration;
    if (lockKey(await realpath(temp)) !== lockKey(temp))
      throw required("工作副本目录指向其他位置，未自动清理。", temp);
    const work = join(temp, "working" + extname(file).toLowerCase());
    let present = true;
    try {
      const stat = await lstat(work);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        lockKey(await realpath(work)) !== lockKey(work)
      )
        throw required("工作副本类型或位置异常，未自动清理。", temp);
    } catch (e) {
      if (e.code === "ENOENT") present = false;
      else throw e;
    }
    if (present) {
      run ??= await engine(context);
      let closed = false,
        last;
      for (
        let attempt = 0;
        attempt < 2 && Date.now() < context.deadline - 500;
        attempt++
      ) {
        try {
          await run(["close", work], undefined, true);
          closed = true;
          break;
        } catch (e) {
          last = e;
        }
      }
      if (!closed)
        throw required(
          `原操作已退出，但工作副本关闭失败，保留锁和副本：${last?.message ?? "剩余时间不足"}`,
          temp,
        );
    }
    // Never remove a directory whose registration or owner changed meanwhile.
    if (!dead(owner.pid) || !same(await readOwner(join(temp, marker)), owner))
      throw required("工作副本持有者状态发生变化，未自动清理。", temp);
    await rm(temp, {
      recursive: true,
      force: true,
      maxRetries: 2,
      retryDelay: 100,
    });
  }
}

export async function recoverAbandonedLock(file, context, closeRun) {
  const lock = file + ".office-work.lock",
    owner = await readOwner(lock);
  if (!owner)
    throw required(
      `锁缺少可验证的持有者信息（可能为旧版空锁），不能自动回收。请确认应用和相关 Office 操作已停止后人工处理：${lock}`,
    );
  if (!valid(owner, file)) {
    if (owner.host && owner.host !== hostname()) return false;
    throw required(`锁持有者信息不完整，不能安全回收：${lock}`);
  }
  if (!dead(owner.pid)) return false;
  // Serialize the identity check and removal. A second recoverer must re-read
  // the lock after obtaining this guard, so it cannot delete a new live lock.
  const guard = lock + ".recovery",
    guardOwner = newLockOwner(file);
  let handle;
  try {
    handle = await open(guard, "wx");
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const other = await readOwner(guard);
    if (valid(other, file) && !dead(other.pid)) return false;
    throw required(
      `恢复标记残留或状态无法确认，未自动删除锁和工作副本，请人工确认：${guard}`,
    );
  }
  try {
    await handle.writeFile(JSON.stringify(guardOwner));
    const current = await readOwner(lock);
    if (!same(current, owner) || !dead(owner.pid)) return false;
    await recoverWorkingCopies(file, context, closeRun, owner);
    if (!dead(owner.pid)) return false;
    await releaseLock(lock, owner);
    return true;
  } finally {
    await handle.close();
    await releaseLock(guard, guardOwner);
  }
}

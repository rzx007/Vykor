import { getProjectMemoryDir, withSettingsFileLock } from "@vykor/core";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryManager, type MemoryEntry } from "@vykor/memory";
import { getDetachedProcessSupervisor } from "@vykor/services";
import { ApplicationError } from "../../shared/application-error.js";

import type { MemoryEntryRecord, MemoryService } from "../settings-api.js";

export function createDefaultMemoryService(): MemoryService {
  return {
    async list({ cwd }) {
      const { manager, directory } = await openMemoryManager(cwd);
      const entries = await manager.getAll();
      return { directory, entries: entries.map(toMemoryRecord) };
    },
    async get({ cwd, id }) {
      const { manager } = await openMemoryManager(cwd);
      const entry = await manager.get(id);
      return entry ? toMemoryRecord(entry) : null;
    },
    async add({ cwd, content, tags }) {
      const { manager } = await openMemoryManager(cwd);
      const entry = await manager.add(content, tags);
      await manager.reload();
      return toMemoryRecord((await manager.get(entry.id))!);
    },
    async remove({ cwd, id, expectedRevision }) {
      return withMemoryMutation(cwd, async (manager, directory) => {
        const entry = await manager.get(id);
        if (!entry) return false;
        if (expectedRevision !== undefined)
          assertRevision(entry, expectedRevision);
        await verifyMemoryFile(directory, id);
        return manager.delete(id);
      });
    },
    async update({ cwd, id, content, expectedRevision }) {
      if (
        typeof content !== "string" ||
        !content.trim() ||
        content.length > 100_000
      )
        throw new Error("记忆内容不能为空或超过 100000 字符。");
      return withMemoryMutation(cwd, async (manager, directory) => {
        const entry = await manager.get(id);
        if (!entry) throw new Error("记忆条目已不存在，请重新读取。");
        assertRevision(entry, expectedRevision);
        await verifyMemoryFile(directory, id);
        const { source_message_sha256: _priorHash, ...metadata } =
          entry.metadata ?? {};
        const updated = await manager.update(id, {
          content,
          name: content.trim().split(/\r?\n/)[0],
          description: content.trim().split(/\r?\n/)[0],
          metadata: { ...metadata, source_type: "manual_edit" },
        });
        if (!updated) throw new Error("记忆条目已不存在。");
        await manager.reload();
        return toMemoryRecord((await manager.get(updated.id))!);
      });
    },
    async clear({ cwd, expectedEntries }) {
      if (!Array.isArray(expectedEntries) || expectedEntries.length > 10_000)
        throw new Error("清理条目清单无效。");
      return withMemoryMutation(cwd, async (manager, directory) => {
        const entries = await manager.getAll();
        const expected = new Map(
          expectedEntries.map((item) => [item.id, item.revision]),
        );
        if (
          expected.size !== expectedEntries.length ||
          expected.size !== entries.length
        )
          throw new ApplicationError(409, "项目记忆已变化，请重新读取后清空。");
        for (const entry of entries)
          assertRevision(entry, expected.get(entry.id));
        const backup = new Map<string, string>();
        for (const entry of entries) {
          await verifyMemoryFile(directory, entry.id);
          backup.set(
            entry.id,
            await readFile(join(directory, `${entry.id}.md`), "utf8"),
          );
        }
        const index = await readFile(
          join(directory, "MEMORY.md"),
          "utf8",
        ).catch(() => undefined);
        try {
          for (const entry of entries) await manager.delete(entry.id);
        } catch (error) {
          try {
            for (const [id, raw] of backup)
              await writeFile(join(directory, `${id}.md`), raw, "utf8");
            if (index !== undefined)
              await writeFile(join(directory, "MEMORY.md"), index, "utf8");
          } catch {
            throw new Error("清空失败且无法恢复全部记忆，请检查记忆目录权限。");
          }
          throw error;
        }
        return { deleted: entries.length };
      });
    },
  };
}

export async function openMemoryManager(
  cwd: string,
): Promise<{ manager: MemoryManager; directory: string }> {
  const directory = getProjectMemoryDir(cwd);
  const manager = new MemoryManager(1000, directory);
  return { manager, directory };
}

async function withMemoryMutation<T>(
  cwd: string,
  operation: (manager: MemoryManager, directory: string) => Promise<T>,
) {
  const directory = getProjectMemoryDir(cwd);
  const dreaming = getDetachedProcessSupervisor(cwd)
    .listExecutions()
    .some(
      (task) =>
        task.type === "dream" &&
        ["pending", "running", "stopping"].includes(task.status),
    );
  if (dreaming)
    throw new ApplicationError(409, "记忆正在整理，请等待整理结束后重试。");
  await mkdir(directory, { recursive: true });
  return withSettingsFileLock(
    async () => {
      const manager = new MemoryManager(1000, directory);
      return operation(manager, directory);
    },
    { lockPath: join(directory, ".manage.lock") },
  );
}
async function verifyMemoryFile(directory: string, id: string) {
  if (
    typeof id !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(id) ||
    id === "." ||
    id === ".."
  )
    throw new Error("记忆条目 ID 无效。");
  const info = await lstat(join(directory, `${id}.md`));
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("记忆条目不是可安全修改的普通文件。");
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key]),
        ]),
    );
  return value;
}
function revision(entry: MemoryEntry) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(entry)))
    .digest("hex");
}
function assertRevision(entry: MemoryEntry, expected: unknown) {
  if (typeof expected !== "string" || revision(entry) !== expected)
    throw new ApplicationError(
      409,
      "记忆内容已被其他任务修改，请重新读取、比较后保存。",
    );
}
function toMemoryRecord(entry: MemoryEntry): MemoryEntryRecord {
  const metadata = entry.metadata;
  const sourceType = metadata?.source_type;
  const source: MemoryEntryRecord["source"] =
    sourceType === "user_message" ||
    sourceType === "manual_remember" ||
    sourceType === "manual_edit"
      ? {
          type: sourceType,
          ...(typeof metadata?.source_session_id === "string"
            ? { sessionId: metadata.source_session_id }
            : {}),
          ...(typeof metadata?.source_message_sha256 === "string"
            ? { messageSha256: metadata.source_message_sha256 }
            : {}),
        }
      : undefined;
  return {
    id: entry.id,
    content: entry.content,
    ...(entry.tags ? { tags: [...entry.tags] } : {}),
    ...(source ? { source } : {}),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    revision: revision(entry),
  };
}

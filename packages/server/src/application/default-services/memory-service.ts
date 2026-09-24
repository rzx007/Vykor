import { getProjectMemoryDir } from "@vykor/core";
import { MemoryManager, type MemoryEntry } from "@vykor/memory";

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
      return toMemoryRecord(entry);
    },
    async remove({ cwd, id }) {
      const { manager } = await openMemoryManager(cwd);
      return await manager.delete(id);
    },
  };
}

export async function openMemoryManager(cwd: string): Promise<{ manager: MemoryManager; directory: string }> {
  const directory = getProjectMemoryDir(cwd);
  const manager = new MemoryManager(1000, directory);
  return { manager, directory };
}

function toMemoryRecord(entry: MemoryEntry): MemoryEntryRecord {
  return {
    id: entry.id,
    content: entry.content,
    ...(entry.tags ? { tags: [...entry.tags] } : {}),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

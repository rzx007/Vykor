import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getProjectMemoryDir } from "@vykor/core";
import { MemoryManager } from "@vykor/memory";
import { describe, expect, it } from "vitest";

import { createDefaultMemoryService } from "./memory-service.js";

describe("default memory service", () => {
  it("edits a versioned entry and protects stale edits, deletions and clear lists", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "vk-memory-edit-"));
    const oldConfigDir = process.env.VYKOR_CONFIG_DIR;
    process.env.VYKOR_CONFIG_DIR = configDir;
    try {
      const cwd = join(configDir, "project");
      const otherCwd = join(configDir, "other-project");
      const service = createDefaultMemoryService();
      const original = await service.add({ cwd, content: "Use SQLite" });
      const other = await service.add({
        cwd: otherCwd,
        content: "Other project memory",
      });
      expect(original.revision).toMatch(/^[a-f0-9]{64}$/);
      const updated = await service.update!({
        cwd,
        id: original.id,
        content: "Use SQLite with WAL",
        expectedRevision: original.revision!,
      });
      expect(updated.content).toBe("Use SQLite with WAL");
      expect(updated.source?.type).toBe("manual_edit");
      expect((await service.get({ cwd, id: updated.id }))?.revision).toBe(
        updated.revision,
      );
      await expect(
        service.update!({
          cwd,
          id: original.id,
          content: "Overwrite old version",
          expectedRevision: original.revision!,
        }),
      ).rejects.toThrow("其他任务修改");
      await expect(
        service.remove({
          cwd,
          id: original.id,
          expectedRevision: original.revision!,
        }),
      ).rejects.toThrow("其他任务修改");
      await expect(
        service.clear!({
          cwd,
          expectedEntries: [{ id: original.id, revision: original.revision! }],
        }),
      ).rejects.toThrow("其他任务修改");
      await service.add({ cwd, content: "A new entry from another task" });
      await expect(
        service.clear!({
          cwd,
          expectedEntries: [{ id: updated.id, revision: updated.revision! }],
        }),
      ).rejects.toThrow("已变化");
      const entries = (await service.list({ cwd })).entries;
      expect(
        await service.clear!({
          cwd,
          expectedEntries: entries.map((entry) => ({
            id: entry.id,
            revision: entry.revision!,
          })),
        }),
      ).toEqual({ deleted: 2 });
      expect((await service.list({ cwd })).entries).toEqual([]);
      expect(
        (await service.get({ cwd: otherCwd, id: other.id }))?.content,
      ).toBe("Other project memory");
    } finally {
      if (oldConfigDir === undefined) delete process.env.VYKOR_CONFIG_DIR;
      else process.env.VYKOR_CONFIG_DIR = oldConfigDir;
      await rm(configDir, { recursive: true, force: true });
    }
  });
  it("returns stored source details through list and get", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "vk-memory-api-"));
    const oldConfigDir = process.env.VYKOR_CONFIG_DIR;
    process.env.VYKOR_CONFIG_DIR = configDir;
    try {
      const cwd = join(configDir, "project");
      const manager = new MemoryManager(1000, getProjectMemoryDir(cwd));
      const entry = await manager.add("Use SQLite for session state", [], {
        source_type: "user_message",
        source_session_id: "session-123",
        source_message_sha256: "verified-message-hash",
      });
      const service = createDefaultMemoryService();
      const expected = {
        type: "user_message",
        sessionId: "session-123",
        messageSha256: "verified-message-hash",
      };

      expect((await service.get({ cwd, id: entry.id }))?.source).toEqual(
        expected,
      );
      expect((await service.list({ cwd })).entries[0]?.source).toEqual(
        expected,
      );
    } finally {
      if (oldConfigDir === undefined) delete process.env.VYKOR_CONFIG_DIR;
      else process.env.VYKOR_CONFIG_DIR = oldConfigDir;
      await rm(configDir, { recursive: true, force: true });
    }
  });
});

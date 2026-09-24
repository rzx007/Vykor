import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getProjectMemoryDir } from "@vykor/core";
import { MemoryManager } from "@vykor/memory";
import { describe, expect, it } from "vitest";

import { createDefaultMemoryService } from "./memory-service.js";

describe("default memory service", () => {
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
        type: "user_message", sessionId: "session-123", messageSha256: "verified-message-hash",
      };

      expect((await service.get({ cwd, id: entry.id }))?.source).toEqual(expected);
      expect((await service.list({ cwd })).entries[0]?.source).toEqual(expected);
    } finally {
      if (oldConfigDir === undefined) delete process.env.VYKOR_CONFIG_DIR;
      else process.env.VYKOR_CONFIG_DIR = oldConfigDir;
      await rm(configDir, { recursive: true, force: true });
    }
  });
});

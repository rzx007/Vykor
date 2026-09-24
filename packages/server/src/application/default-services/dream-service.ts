import { startDreamNow } from "@vykor/services";

import type { DreamService } from "../settings-api.js";
import { openMemoryManager } from "./memory-service.js";
import type { DaemonSettingsRef } from "./shared.js";

export function createDefaultDreamService(ref: DaemonSettingsRef): DreamService {
  return {
    async start({ cwd, sessionId, preview }) {
      const { manager, directory } = await openMemoryManager(cwd);
      const stale = await manager.findStaleCandidates();
      const staleSection = stale
        .slice(0, 20)
        .map((entry) =>
          `- ${entry.id}: ${entry.id}.md (importance=${entry.importance ?? 0}, updated_at=${new Date(entry.updatedAt).toISOString().slice(0, 10)})`,
        )
        .join("\n");
      const settings = {
        ...ref.current,
        memory: { enabled: true, ...ref.current.memory },
      };
      const task = await startDreamNow({
        cwd,
        settings,
        memoryDir: directory,
        recentSessionIds: sessionId ? [sessionId] : [],
        force: true,
        preview: preview === true,
        currentSessionId: sessionId,
        staleSection,
      });
      if (!task) {
        return {
          started: false,
          reason: "Dream was not started: consolidation lock held, disabled, or inside a dream subprocess",
        };
      }
      return { started: true, taskId: task.id };
    },
  };
}

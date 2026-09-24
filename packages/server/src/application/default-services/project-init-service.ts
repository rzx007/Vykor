import { join } from "node:path";

import { PROJECT_CONFIG_DIR_NAME } from "@vykor/core";

import type { ProjectInitService } from "../settings-api.js";

export function createDefaultProjectInitService(): ProjectInitService {
  return {
    async init({ cwd }) {
      const { writeFile, mkdir, access } = await import("node:fs/promises");
      const files: Array<{ path: string; content: string; label: string }> = [
        {
          path: join(cwd, "CLAUDE.md"),
          content: "# Project Rules\n\nAdd your project-specific rules and instructions here.\n",
          label: "CLAUDE.md",
        },
        {
          path: join(cwd, PROJECT_CONFIG_DIR_NAME, "README.md"),
          content: "# Vykor Config\n\nThis directory contains Vykor project configuration.\n",
          label: `${PROJECT_CONFIG_DIR_NAME}/README.md`,
        },
        {
          path: join(cwd, PROJECT_CONFIG_DIR_NAME, "memory", "MEMORY.md"),
          content: "# Memory\n\nThis file stores project memory for the AI assistant.\n",
          label: `${PROJECT_CONFIG_DIR_NAME}/memory/MEMORY.md`,
        },
      ];
      const dirs = [
        join(cwd, PROJECT_CONFIG_DIR_NAME),
        join(cwd, PROJECT_CONFIG_DIR_NAME, "memory"),
        join(cwd, PROJECT_CONFIG_DIR_NAME, "plugins"),
        join(cwd, PROJECT_CONFIG_DIR_NAME, "skills"),
      ];
      const lines: string[] = ["Initializing Vykor project...", ""];
      for (const dir of dirs) {
        await mkdir(dir, { recursive: true });
      }
      lines.push("  Created directories.");
      for (const file of files) {
        try {
          await access(file.path);
          lines.push(`  Skipped ${file.label} (already exists)`);
        } catch {
          await writeFile(file.path, file.content, "utf-8");
          lines.push(`  Created ${file.label}`);
        }
      }
      lines.push("", "Project initialized successfully.");
      return { report: lines.join("\n") };
    },
  };
}

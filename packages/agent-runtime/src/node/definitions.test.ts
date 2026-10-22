import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getAgentDefinition,
  hasRequiredMcpServers,
} from "@vykor/coordinator/definitions";
import { loadNodeAgentDefinitions } from "./definitions.js";

describe("Node agent definition capture", () => {
  it("captures builtin < user < plugin and keeps other root catalogs isolated", () => {
    const root = mkdtempSync(join(tmpdir(), "vk-captured-definitions-"));
    const users = join(root, "agents");
    mkdirSync(users);
    writeFileSync(
      join(users, "worker.md"),
      "---\nmodel: user-model\nrequiredMcpServers: [database]\n---\nUser worker.",
    );
    writeFileSync(
      join(users, "broken.md"),
      "---\nname: [unclosed\n---\nbroken",
    );
    try {
      const first = loadNodeAgentDefinitions(
        [
          {
            name: "worker",
            description: "plugin worker",
            model: "plugin-model",
            source: "plugin",
          },
        ],
        users,
      );
      const second = loadNodeAgentDefinitions([], users);
      expect(getAgentDefinition("worker", first)?.model).toBe("plugin-model");
      expect(getAgentDefinition("worker", second)?.model).toBe("user-model");
      const user = getAgentDefinition("worker", second)!;
      expect(hasRequiredMcpServers(user, ["my-DATABASE-server"])).toBe(true);
      expect(hasRequiredMcpServers(user, ["files"])).toBe(false);
      writeFileSync(
        join(users, "worker.md"),
        "---\nmodel: later-model\n---\nLater",
      );
      expect(getAgentDefinition("worker", second)?.model).toBe("user-model");
      expect(
        getAgentDefinition("worker", loadNodeAgentDefinitions([], users))
          ?.model,
      ).toBe("later-model");
      expect(getAgentDefinition("worker")?.model).toBeUndefined();
      expect(
        getAgentDefinition(
          "worker",
          loadNodeAgentDefinitions([], join(root, "missing")),
        )?.source,
      ).toBe("builtin");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

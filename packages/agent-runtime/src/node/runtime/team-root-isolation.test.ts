import type { StreamingMessageClient } from "@vykor/agent-contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { TeamRegistry } from "@vykor/coordinator/teams";

import { createDefaultNodeAgent } from "./default-agent.js";

it("keeps same-named teams separate between roots and shares each root with its children", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vk-root-teams-"));
  const created = vi.spyOn(TeamRegistry.prototype, "createTeam");
  const deleted = vi.spyOn(TeamRegistry.prototype, "deleteTeam");
  const client: StreamingMessageClient = {
    async *streamMessage(request) {
      const latest = request.messages.at(-1)!;
      if (latest.type === "user") {
        const text = typeof latest.content === "string" ? latest.content : latest.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        const name = text === "create" ? "TeamCreate" : text === "spawn" ? "Agent" : /\bdelete\b/.test(text) ? "TeamDelete" : undefined;
        if (name) {
          yield { type: "tool_use_start", toolUse: { type: "tool_use", id: `call-${request.messages.length}`, name,
            input: name === "Agent" ? { description: "child work", prompt: "delete", subagentType: "general-purpose", team: "dev" } : { name: "dev" } } };
          yield { type: "complete", stopReason: "tool_use" };
          return;
        }
      }
      yield { type: "complete", stopReason: "end_turn" };
    },
  };
  const options = {
    cwd, client, pluginsEnabled: false, systemPrompt: "test",
    settings: { model: "test", apiFormat: "anthropic" as const, maxTurns: 3,
      permission: { mode: "full_auto" as const }, sandbox: { enabled: false }, memory: { enabled: false } },
    capabilityOverrides: { terminal: false as const, backgroundShell: false as const, memory: false as const, workflowRepository: false as const },
  };
  let first: Awaited<ReturnType<typeof createDefaultNodeAgent>> | undefined;
  let second: Awaited<ReturnType<typeof createDefaultNodeAgent>> | undefined;
  try {
    first = await createDefaultNodeAgent(options);
    second = await createDefaultNodeAgent(options);
    await first.runMessage("create");
    await second.runMessage("create");
    expect(created).toHaveBeenCalledTimes(2);
    const registryA = created.mock.contexts[0]!;
    const registryB = created.mock.contexts[1]!;
    expect(registryA).not.toBe(registryB);
    await first.runMessage("spawn");
    const child = first.children.list()[0]!;
    expect(await child.result).toMatchObject({ status: "completed" });
    expect(deleted).toHaveBeenCalledTimes(1);
    expect(deleted).toHaveBeenLastCalledWith("dev");
    expect(deleted.mock.contexts[0]).toBe(registryA);
    expect(registryA.listTeams()).toEqual([]);
    expect(registryB.listTeams().map((team) => team.name)).toEqual(["dev"]);
    await first.close();
    await second.runMessage("delete");
    expect(deleted).toHaveBeenCalledTimes(2);
    expect(deleted.mock.contexts[1]).toBe(registryB);
    expect(registryB.listTeams()).toEqual([]);
  } finally {
    const cleanup = await Promise.allSettled([first?.close(), second?.close()]);
    created.mockRestore();
    deleted.mockRestore();
    rmSync(cwd, { recursive: true, force: true });
    for (const result of cleanup) {
      if (result.status === "rejected") throw result.reason;
    }
  }
});

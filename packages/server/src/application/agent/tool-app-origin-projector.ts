import type { AgentEvent } from "@vykor/agent-contracts";
import type { AgentRunCapabilitySnapshot } from "@vykor/agent-runtime";
import type { PluginAppToolOrigin } from "@vykor/plugin-contracts/runtime";

interface CapturedRun {
  snapshot: AgentRunCapabilitySnapshot;
  calls: Map<string, string>;
  origins: Map<string, PluginAppToolOrigin | undefined>;
}

/** Product metadata comes from the actual authorized Run, never a free event field. */
export class ToolAppOriginProjector {
  private readonly runs = new Map<string, CapturedRun>();

  capture(snapshot: AgentRunCapabilitySnapshot): () => void {
    const runId = snapshot.scope.runId;
    if (this.runs.has(runId))
      throw new Error(`Tool origins already captured for Run: ${runId}`);
    const captured: CapturedRun = {
      snapshot,
      calls: new Map(),
      origins: new Map(),
    };
    this.runs.set(runId, captured);
    return () => {
      if (this.runs.get(runId) === captured) this.runs.delete(runId);
    };
  }

  started(event: Extract<AgentEvent, { type: "tool.started" }>): void {
    const captured = event.context.runId
      ? this.runs.get(event.context.runId)
      : undefined;
    if (captured?.snapshot.scope.sessionId === event.context.sessionId)
      captured.calls.set(event.data.toolUse.id, event.data.toolUse.name);
  }

  async completed(
    event: Extract<AgentEvent, { type: "tool.completed" }>,
  ): Promise<PluginAppToolOrigin | undefined> {
    if (
      event.data.result.isError ||
      event.data.result.executionState !== "completed"
    )
      return;
    const captured = event.context.runId
      ? this.runs.get(event.context.runId)
      : undefined;
    if (
      !captured ||
      captured.snapshot.scope.sessionId !== event.context.sessionId
    )
      return;
    const id = event.data.toolUseId;
    const name = captured.calls.get(id);
    if (!name) return;
    if (captured.origins.has(id)) return captured.origins.get(id);
    const binding = captured.snapshot.capabilityView.tools.get(name);
    if (!binding) return;
    let origin: PluginAppToolOrigin | undefined;
    try {
      origin = await captured.snapshot.resolveToolAppOrigin?.(binding);
    } catch {
      // A changed/unavailable source still produces an ordinary tool result.
    }
    if (origin?.toolName !== name) origin = undefined;
    captured.origins.set(id, origin);
    return origin;
  }
}

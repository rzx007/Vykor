import type { VykorAgent } from "@vykor/agent-runtime";
import type { AgentChildInput, AgentInputReceipt } from "@vykor/core";

interface LiveChildEntry {
  childId: string;
  rootAgent: VykorAgent;
}

/** Routes daemon commands through the framework-owned child directory. */
export class LiveChildAgentDirectory {
  private readonly entries = new Map<string, LiveChildEntry>();

  register(sessionId: string, childId: string, rootAgent: VykorAgent): void {
    const current = this.entries.get(sessionId);
    if (current && (current.childId !== childId || current.rootAgent !== rootAgent)) {
      throw new Error(`Child agent is already live for session: ${sessionId}`);
    }
    this.entries.set(sessionId, { childId, rootAgent });
  }

  unregister(sessionId: string, childId: string): void {
    const current = this.entries.get(sessionId);
    if (current?.childId === childId) this.entries.delete(sessionId);
  }

  has(sessionId: string): boolean {
    const current = this.entries.get(sessionId);
    if (!current) return false;
    if (current.rootAgent.children.get(current.childId)) return true;
    this.entries.delete(sessionId);
    return false;
  }

  resolveRootSessionId(sessionId: string): string | undefined {
    const current = this.entries.get(sessionId);
    if (!current) return undefined;
    if (current.rootAgent.children.get(current.childId)) return current.rootAgent.id;
    this.entries.delete(sessionId);
    return undefined;
  }

  async send(sessionId: string, input: AgentChildInput): Promise<AgentInputReceipt | undefined> {
    const current = this.entries.get(sessionId);
    if (!current) return undefined;
    const child = current.rootAgent.children.get(current.childId);
    if (!child) {
      this.entries.delete(sessionId);
      return undefined;
    }
    return await child.send(input);
  }

  async interrupt(sessionId: string, reason?: string): Promise<boolean> {
    const current = this.entries.get(sessionId);
    if (!current) return false;
    const child = current.rootAgent.children.get(current.childId);
    if (!child) {
      this.entries.delete(sessionId);
      return false;
    }
    await child.interrupt(reason);
    return true;
  }
}

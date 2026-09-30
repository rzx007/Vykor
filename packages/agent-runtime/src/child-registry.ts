import { isDeepStrictEqual } from "node:util";
import { AgentChildBudgetExceededError, type AgentChildBudget, type AgentChildBudgetSnapshot, type AgentChildDirectory, type AgentChildHandle } from "@vykor/core";

export const DEFAULT_AGENT_CHILD_BUDGET: AgentChildBudget = {
  maxDepth: 4,
  maxActiveChildren: 8,
  maxTotalChildren: 64,
};

export interface AgentChildBudgetReservation {
  commit(): void;
  rollback(): void;
  release(): void;
}

/** Shared live-handle index for the complete descendant tree of one root agent. */
export class AgentChildRegistry implements AgentChildDirectory {
  private readonly byId = new Map<string, AgentChildHandle>();
  private readonly bySessionId = new Map<string, AgentChildHandle>();
  private readonly depthBySessionId = new Map<string, number>();
  private budget: AgentChildBudget;
  private activeChildren = 0;
  private totalChildren = 0;

  constructor(budget: AgentChildBudget = DEFAULT_AGENT_CHILD_BUDGET) {
    this.budget = normalizeChildBudget(budget);
  }

  configureBudget(budget: AgentChildBudget): void {
    if (this.activeChildren > 0 || this.totalChildren > 0) {
      if (!isDeepStrictEqual(this.budget, budget)) {
        throw new Error("Child budget cannot change after the root tree starts allocating children");
      }
      return;
    }
    this.budget = normalizeChildBudget(budget);
  }

  snapshotBudget(): AgentChildBudgetSnapshot {
    return { ...this.budget, activeChildren: this.activeChildren, totalChildren: this.totalChildren };
  }

  reserve(
    parentSessionId: string,
    childSessionId: string,
    options: { system?: boolean } = {},
  ): AgentChildBudgetReservation {
    const system = options.system === true;
    if (this.depthBySessionId.has(childSessionId)) {
      throw new Error(`Child agent session is already live or being allocated: ${childSessionId}`);
    }
    const childDepth = (this.depthBySessionId.get(parentSessionId) ?? 0) + 1;
    if (childDepth > this.budget.maxDepth) {
      throw new AgentChildBudgetExceededError("depth", this.budget.maxDepth, childDepth);
    }
    if (this.activeChildren >= this.budget.maxActiveChildren) {
      throw new AgentChildBudgetExceededError(
        "activeChildren",
        this.budget.maxActiveChildren,
        this.activeChildren,
      );
    }
    if (!system && this.totalChildren >= this.budget.maxTotalChildren) {
      throw new AgentChildBudgetExceededError(
        "totalChildren",
        this.budget.maxTotalChildren,
        this.totalChildren,
      );
    }

    this.activeChildren++;
    if (!system) this.totalChildren++;
    this.depthBySessionId.set(childSessionId, childDepth);
    let state: "reserved" | "committed" | "released" = "reserved";
    return {
      commit: () => {
        if (state === "reserved") state = "committed";
      },
      rollback: () => {
        if (state !== "reserved") return;
        state = "released";
        this.activeChildren--;
        if (!system) this.totalChildren--;
        this.depthBySessionId.delete(childSessionId);
      },
      release: () => {
        if (state === "released") return;
        const rollbackTotal = state === "reserved";
        state = "released";
        this.activeChildren--;
        if (rollbackTotal && !system) this.totalChildren--;
        this.depthBySessionId.delete(childSessionId);
      },
    };
  }

  register(handle: AgentChildHandle): void {
    const existingId = this.byId.get(handle.id);
    const existingSession = this.bySessionId.get(handle.sessionId);
    if ((existingId && existingId !== handle) || (existingSession && existingSession !== handle)) {
      throw new Error(`Child agent identity is already live: ${handle.id}/${handle.sessionId}`);
    }
    this.byId.set(handle.id, handle);
    this.bySessionId.set(handle.sessionId, handle);
  }

  unregister(handle: AgentChildHandle): void {
    if (this.byId.get(handle.id) === handle) this.byId.delete(handle.id);
    if (this.bySessionId.get(handle.sessionId) === handle) this.bySessionId.delete(handle.sessionId);
  }

  get(childId: string): AgentChildHandle | undefined {
    return this.byId.get(childId);
  }

  getBySessionId(sessionId: string): AgentChildHandle | undefined {
    return this.bySessionId.get(sessionId);
  }

  list(): AgentChildHandle[] {
    return [...this.byId.values()];
  }
}

export function resolveChildBudget(
  settings: Partial<AgentChildBudget> | undefined,
  configuration: Partial<AgentChildBudget> | undefined,
): AgentChildBudget {
  return normalizeChildBudget({ ...DEFAULT_AGENT_CHILD_BUDGET, ...settings, ...configuration });
}

function normalizeChildBudget(budget: AgentChildBudget): AgentChildBudget {
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Child budget ${name} must be a non-negative safe integer`);
    }
  }
  return { ...budget };
}

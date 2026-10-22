import { randomUUID } from "node:crypto";

import type { ContentBlock, Message } from "@vykor/agent-contracts";
import type { StreamEvent } from "@vykor/agent-contracts";
import type { QueryEngine as IQueryEngine } from "./types/runtime.js";
import type { AgentExecutionContext } from "@vykor/agent-contracts";

export interface AgentSessionSubmitOptions {
  signal?: AbortSignal;
  execution?: AgentExecutionContext;
}

export interface AgentSessionOptions {
  queryEngine: IQueryEngine;
  sessionId?: string;
}

/** Thin stateful wrapper around QueryEngine. Run ownership lives in agent-runtime. */
export class AgentSession {
  private readonly sessionId: string;

  constructor(private readonly options: AgentSessionOptions) {
    this.sessionId = options.sessionId ?? `agent_session_${randomUUID()}`;
    this.options.queryEngine.setSessionId(this.sessionId);
  }

  get id(): string {
    return this.sessionId;
  }

  submitMessage(
    content: string | ContentBlock[],
    options: AgentSessionSubmitOptions = {},
  ): AsyncIterable<StreamEvent> {
    return this.options.queryEngine.submitMessage(content, options);
  }

  getHistory(): Message[] {
    return this.options.queryEngine.getHistory();
  }

  clear(): void {
    this.options.queryEngine.clear();
  }
}

export function createAgentSession(options: AgentSessionOptions): AgentSession {
  return new AgentSession(options);
}

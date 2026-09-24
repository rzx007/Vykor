import { randomUUID } from "node:crypto";

import type {
  AgentEvent,
  AgentEventContext,
  AgentEventInput,
  AgentEventListener,
  AgentEventSource,
  AgentEventSubscription,
} from "@vykor/core";

export class AgentEventDeliveryError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "AgentEventDeliveryError";
  }
}

export class AgentEventBus implements AgentEventSource {
  private readonly listeners = new Set<AgentEventListener>();
  private sequence = 0;
  private delivery: Promise<void> = Promise.resolve();

  constructor(private readonly sink?: AgentEventListener) {}

  subscribe(listener: AgentEventListener): AgentEventSubscription {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async emit(input: AgentEventInput, context: AgentEventContext): Promise<AgentEvent> {
    const event = {
      ...input,
      id: `agent_event_${randomUUID()}`,
      sequence: ++this.sequence,
      occurredAt: new Date().toISOString(),
      context,
    } as AgentEvent;
    const delivered = this.delivery.then(async () => {
      if (this.sink) {
        try {
          await this.sink(event);
        } catch (error) {
          throw new AgentEventDeliveryError(error);
        }
      }
      for (const listener of [...this.listeners]) {
        try {
          void Promise.resolve(listener(event)).catch(() => {});
        } catch {
          // Observers cannot change execution outcome. Use onEvent for reliable host delivery.
        }
      }
    });
    this.delivery = delivered.catch(() => {});
    await delivered;
    return event;
  }

  async drain(): Promise<void> {
    await this.delivery;
  }
}

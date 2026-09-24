import type { TerminalEvent } from "@vykor/protocol";

export type { TerminalEvent } from "@vykor/protocol";

export type TerminalEventListener = (event: TerminalEvent) => void

export class TerminalEventBus {
  private readonly listeners = new Set<TerminalEventListener>()

  subscribe(listener: TerminalEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(event: TerminalEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  clear(): void {
    this.listeners.clear()
  }
}

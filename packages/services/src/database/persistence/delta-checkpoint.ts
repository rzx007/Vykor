export interface DeltaCheckpointOptions {
  intervalMs: number;
  bytes: number;
  flush: () => void;
}

export interface DeltaCheckpointSnapshot {
  partIds: Set<string>;
  pendingBytes: number;
}

export class DeltaCheckpoint {
  private readonly partIds = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  pendingBytes = 0;

  constructor(private readonly options: DeltaCheckpointOptions) {}

  markDirty(partId: string, addedBytes: number): boolean {
    this.partIds.add(partId);
    this.pendingBytes += addedBytes;
    return this.pendingBytes >= this.options.bytes;
  }

  delete(partId: string): void {
    this.partIds.delete(partId);
    if (this.partIds.size === 0) this.pendingBytes = 0;
  }

  dirtyPartIds(): string[] {
    return [...this.partIds];
  }

  reachedThreshold(): boolean {
    return this.pendingBytes >= this.options.bytes;
  }

  snapshot(): DeltaCheckpointSnapshot {
    return {
      partIds: new Set(this.partIds),
      pendingBytes: this.pendingBytes,
    };
  }

  restore(snapshot: DeltaCheckpointSnapshot): void {
    this.partIds.clear();
    for (const partId of snapshot.partIds) this.partIds.add(partId);
    this.pendingBytes = snapshot.pendingBytes;
    this.clearTimer();
    this.schedule();
  }

  clear(): void {
    this.partIds.clear();
    this.pendingBytes = 0;
    this.clearTimer();
  }

  schedule(): void {
    if (this.timer || this.closed || this.partIds.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        this.options.flush();
      } catch {
        this.schedule();
      }
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  close(): void {
    this.closed = true;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

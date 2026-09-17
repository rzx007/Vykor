type OperationKind = "shared" | "exclusive";

interface WaitingOperation {
  kind: OperationKind;
  start(): void;
}

/**
 * Coordinates attachment imports with destructive storage maintenance.
 * Imports may run together; repair and GC wait for every import and block new ones.
 */
export class AttachmentStorageOperationGate {
  private activeReaders = 0;
  private activeWriter = false;
  private readonly waiting: WaitingOperation[] = [];

  runShared<T>(operation: () => Promise<T>): Promise<T> {
    return this.run("shared", operation);
  }

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.run("exclusive", operation);
  }

  private run<T>(kind: OperationKind, operation: () => Promise<T>): Promise<T> {
    return new Promise<void>((resolve) => {
      this.waiting.push({ kind, start: resolve });
      this.drain();
    }).then(async () => {
      try {
        return await operation();
      } finally {
        if (kind === "shared") this.activeReaders--;
        else this.activeWriter = false;
        this.drain();
      }
    });
  }

  private drain(): void {
    if (this.activeWriter || this.waiting.length === 0) return;
    const first = this.waiting[0]!;
    if (first.kind === "exclusive") {
      if (this.activeReaders > 0) return;
      this.activeWriter = true;
      this.waiting.shift()!.start();
      return;
    }
    while (this.waiting[0]?.kind === "shared") {
      this.activeReaders++;
      this.waiting.shift()!.start();
    }
  }
}

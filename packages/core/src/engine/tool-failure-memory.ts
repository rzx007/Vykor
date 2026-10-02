export class ToolFailureMemory {
  private evidenceRevision = 0;
  private readonly failures = new Map<string, number>();

  recordFailure(toolName: string, input: Record<string, unknown>): void {
    this.failures.set(signature(toolName, input), this.evidenceRevision);
  }

  shouldReplayFailure(toolName: string, input: Record<string, unknown>): boolean {
    return this.failures.get(signature(toolName, input)) === this.evidenceRevision;
  }

  noteEvidence(): void {
    this.evidenceRevision += 1;
  }
}

function signature(toolName: string, input: Record<string, unknown>): string {
  return `${toolName}:${stableJson(input)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

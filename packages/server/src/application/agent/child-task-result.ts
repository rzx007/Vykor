import type { AgentChildResult } from "@vykor/agent-contracts";
import type { UpdateSessionTaskInput } from "@vykor/services";

/** One field mapping for terminal projection and replay; never derives errors from reports. */
export function childTaskResultPatch(result: AgentChildResult): UpdateSessionTaskInput {
  return {
    status: result.status,
    output: result.output,
    error: result.error ?? null,
    metadata: {
      childFailure: result.failureKind || result.partialResult ? {
        ...(result.failureKind ? { failureKind: result.failureKind } : {}),
        ...(result.partialResult ? { partialResult: result.partialResult } : {}),
      } : null,
    },
  };
}

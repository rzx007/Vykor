import type { ToolContext } from "@vykor/agent-contracts";
import type { EnvironmentFileSystem } from "@vykor/environment";
import { withUnidentifiedFileMutationLock } from "@vykor/execution-node";

/** Legacy/custom backends have no proven target identity: exclude every cooperating mutation. */
export function withFileMutationLock<T>(
  operations: EnvironmentFileSystem,
  paths: readonly string[],
  context: ToolContext,
  work: () => Promise<T>,
): Promise<T> {
  return operations.withMutationLock
    ? operations.withMutationLock(paths, work, context.abortSignal)
    : withUnidentifiedFileMutationLock(work, context.abortSignal);
}

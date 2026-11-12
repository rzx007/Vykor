import type { ToolContext } from "@vykor/agent-contracts";
import type { EnvironmentPathOperation } from "@vykor/environment";
import { resolveManagedHistoryPath } from "@vykor/host-config/paths";

import { resolveToolPath } from "../path.js";

export async function resolveToolPathInContext(
  rawPath: string,
  context: ToolContext,
  operation: EnvironmentPathOperation,
): Promise<string> {
  rawPath = await resolveManagedHistoryPath(rawPath);
  if (context.environment) {
    return (await context.environment.paths.resolve(rawPath, operation))
      .executionPath;
  }
  return resolveToolPath(rawPath, context.cwd);
}

import type { ToolContext } from "@vykor/core";
import type { EnvironmentPathOperation } from "@vykor/environment";

import { resolveToolPath } from "./path.js";

export async function resolveToolPathInContext(
  rawPath: string,
  context: ToolContext,
  operation: EnvironmentPathOperation,
): Promise<string> {
  if (context.environment) {
    return (await context.environment.paths.resolve(rawPath, operation))
      .executionPath;
  }
  return resolveToolPath(rawPath, context.cwd);
}

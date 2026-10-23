import type { EnvironmentPtyTarget } from "@vykor/environment";

export function createHostTerminalTarget(input: {
  cwd: string;
  shell: string;
  shellArgs?: string[];
  env?: Record<string, string>;
}): EnvironmentPtyTarget {
  return {
    command: input.shell,
    args: [...(input.shellArgs ?? [])],
    ...(input.env ? { env: { ...input.env } } : {}),
    hostCwd: input.cwd,
    executionCwd: input.cwd,
    shell: input.shell,
    environmentKind: "native",
    async signal() {},
    async close() {},
  };
}

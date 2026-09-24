import type { EnvironmentPtyTarget } from "@vykor/environment";

export function createHostTerminalTarget(input: {
  cwd: string;
  shell: string;
}): EnvironmentPtyTarget {
  return {
    command: input.shell,
    args: [],
    hostCwd: input.cwd,
    executionCwd: input.cwd,
    shell: input.shell,
    async signal() {},
    async close() {},
  };
}

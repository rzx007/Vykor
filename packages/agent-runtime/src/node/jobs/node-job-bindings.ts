import { RoutedAgentJobHost, type AgentJobHost } from "@vykor/jobs";
import type { AgentBackgroundShellHost } from "@vykor/tools";
import {
  createChildJobSource,
  type ChildJobSourceOptions,
} from "./child-job-source.js";
import {
  createProcessJobSource,
  type ProcessJobSourceOptions,
} from "./process-job-source.js";

export interface NodeJobBindingsOptions {
  child: ChildJobSourceOptions;
  process: ProcessJobSourceOptions;
  terminal?: AgentJobHost;
  workflow?: AgentJobHost;
}
export interface NodeJobBindings {
  jobs: AgentJobHost;
  backgroundShell: AgentBackgroundShellHost;
}
/** SDK 与 daemon 唯一的 Node 来源组装入口。 */
export function createNodeJobBindings(
  options: NodeJobBindingsOptions,
): NodeJobBindings {
  const process = createProcessJobSource(options.process);
  return {
    backgroundShell: process.backgroundShell,
    jobs: new RoutedAgentJobHost({
      agent: createChildJobSource(options.child),
      shell: process.jobs,
      dream: process.jobs,
      ...(options.terminal ? { terminal: options.terminal } : {}),
      ...(options.workflow ? { workflow: options.workflow } : {}),
    }),
  };
}

import type { AgentJobHost } from "@vykor/jobs";
import type { AgentTerminalHost, TerminalProvider } from "@vykor/terminal";
import { createAgentTerminalBundle } from "@vykor/terminal-node";
import type { Cleanup } from "../runtime/cleanup-stack.js";

export interface DefaultNodeTerminalProducer { value: AgentTerminalHost; jobs: AgentJobHost }
export interface CreatedCapability<T> { value: T; cleanup: Cleanup; cleanupIdentity: object }
export type DefaultNodeTerminalResolution = ({ status: "available"; source: "default" | "override" } & CreatedCapability<DefaultNodeTerminalProducer>) | { status: "disabled" };
export async function createDefaultNodeTerminal(input: { cwd: string; sessionId: string; provider?: TerminalProvider }): Promise<CreatedCapability<DefaultNodeTerminalProducer>> {
  const bundle = createAgentTerminalBundle({ ...input, ownsProvider: !input.provider });
  return { value: { value: bundle.terminal, jobs: bundle.jobs }, cleanup: bundle.cleanup, cleanupIdentity: bundle.cleanupIdentity };
}
export async function resolveDefaultNodeTerminal(input: { override: TerminalProvider | false | undefined; cwd: string; sessionId: string; createLocal: () => Promise<CreatedCapability<DefaultNodeTerminalProducer>> }): Promise<DefaultNodeTerminalResolution> {
  if (input.override === false) return { status: "disabled" };
  if (input.override) return { status: "available", source: "override", ...await createDefaultNodeTerminal({ cwd: input.cwd, sessionId: input.sessionId, provider: input.override }) };
  return { status: "available", source: "default", ...await input.createLocal() };
}

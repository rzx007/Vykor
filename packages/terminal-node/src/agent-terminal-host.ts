import {
  filterJobSnapshots,
  isTerminalJobStatus,
  type AgentJobHost,
  type JobReadResult,
  type JobSnapshot,
} from "@vykor/jobs";
import {
  type AgentTerminalHost,
  type TerminalCreateRequest,
  type TerminalEventListener,
  type TerminalProvider,
  type TerminalSessionInfo,
} from "@vykor/terminal";

import { LocalTerminalProvider } from "./local-terminal-provider.js";

export interface AgentTerminalProvider extends Pick<
  TerminalProvider,
  "create" | "list" | "read" | "wait" | "write" | "kill" | "subscribe"
> {
  dispose(): Promise<void>;
}

export interface CreateAgentTerminalBundleOptions {
  cwd: string;
  sessionId: string;
  provider?: AgentTerminalProvider;
}

export interface AgentTerminalBundle {
  terminal: AgentTerminalHost;
  jobs: AgentJobHost;
  cleanup(): Promise<void>;
  cleanupIdentity: object;
}

interface TerminalObservation {
  updatedAt: number;
}

export function createAgentTerminalBundle(
  options: CreateAgentTerminalBundleOptions,
): AgentTerminalBundle {
  const provider = options.provider ?? new LocalTerminalProvider({
    resolveCwd: async (input) => input.cwd ?? options.cwd,
  });
  const observations = new Map<string, TerminalObservation>();
  const observeEvent: TerminalEventListener = (event) => {
    const observation = observations.get(event.terminalId);
    if (!observation) return;
    observation.updatedAt = Date.now();
  };
  const unsubscribe = provider.subscribe(observeEvent);

  const jobs: AgentJobHost = {
    list: async (input) => {
      assertOwner(input.sessionId, options.sessionId);
      const terminals = await ownedTerminals(provider, options.sessionId);
      return filterJobSnapshots(
        terminals.map((terminal) => snapshot(terminal, observationFor(terminal, observations))),
        input,
      );
    },
    read: async (input) => {
      assertOwner(input.sessionId, options.sessionId);
      await requireOwnedTerminal(provider, input.jobId, options.sessionId);
      const result = await provider.read({
        terminalId: input.jobId,
        ...(input.after !== undefined ? { after: input.after } : {}),
        ...(input.maxChars !== undefined ? { maxChars: input.maxChars } : {}),
      });
      const terminal = await requireOwnedTerminal(provider, input.jobId, options.sessionId);
      return readResult(result, snapshot(terminal, observationFor(terminal, observations)));
    },
    wait: async (input) => {
      assertOwner(input.sessionId, options.sessionId);
      await requireOwnedTerminal(provider, input.jobId, options.sessionId);
      const result = await provider.wait({
        terminalId: input.jobId,
        timeoutMs: input.timeoutMs,
        ...(input.after !== undefined ? { after: input.after } : {}),
        ...(input.maxChars !== undefined ? { maxChars: input.maxChars } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      const observation = observationFor(result.terminal, observations);
      return {
        ...readResult(result, snapshot(result.terminal, observation)),
        timedOut: result.timedOut,
      };
    },
    send: async (input) => {
      assertOwner(input.sessionId, options.sessionId);
      await requireOwnedTerminal(provider, input.jobId, options.sessionId);
      await provider.write({ terminalId: input.jobId, data: input.data });
      observationFor(
        await requireOwnedTerminal(provider, input.jobId, options.sessionId),
        observations,
      ).updatedAt = Date.now();
    },
    cancel: async (input) => {
      assertOwner(input.sessionId, options.sessionId);
      const terminal = await requireOwnedTerminal(provider, input.jobId, options.sessionId);
      const observation = observationFor(terminal, observations);
      await provider.kill(input.jobId);
      observation.updatedAt = Date.now();
      return snapshot(
        await requireOwnedTerminal(provider, input.jobId, options.sessionId),
        observation,
      );
    },
  };

  const terminal: AgentTerminalHost = {
    open: async (input) => {
      if (input.sessionId !== options.sessionId) {
        throw new Error("Terminal owner session mismatch.");
      }
      if (input.cwd !== options.cwd) throw new Error("Terminal cwd mismatch.");
      const created = await provider.create(createRequest(input, options.sessionId));
      observationFor(created, observations);
      return created;
    },
  };

  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= Promise.resolve().then(async () => {
      unsubscribe();
      await provider.dispose();
    });
    return cleanupPromise;
  };

  return { terminal, jobs, cleanup, cleanupIdentity: provider };
}

function createRequest(
  input: Parameters<AgentTerminalHost["open"]>[0],
  sessionId: string,
): TerminalCreateRequest {
  return {
    scope: { kind: "session", sessionId },
    runtime: "local",
    cols: input.cols ?? 100,
    rows: input.rows ?? 30,
    name: input.name ?? "Agent terminal",
    ...(input.shell !== undefined ? { shell: input.shell } : {}),
    cwd: input.cwd,
    source: "agent",
  };
}

async function ownedTerminals(
  provider: AgentTerminalProvider,
  sessionId: string,
): Promise<TerminalSessionInfo[]> {
  return (await provider.list()).filter((terminal) => terminal.sessionId === sessionId);
}

async function requireOwnedTerminal(
  provider: AgentTerminalProvider,
  terminalId: string,
  sessionId: string,
): Promise<TerminalSessionInfo> {
  const terminal = (await ownedTerminals(provider, sessionId))
    .find((candidate) => candidate.id === terminalId);
  if (!terminal) throw new Error(`Job not found: ${terminalId}`);
  return terminal;
}

function observationFor(
  terminal: TerminalSessionInfo,
  observations: Map<string, TerminalObservation>,
): TerminalObservation {
  let observation = observations.get(terminal.id);
  if (!observation) {
    observation = { updatedAt: timestamp(terminal.createdAt) };
    observations.set(terminal.id, observation);
  }
  return observation;
}

function snapshot(
  terminal: TerminalSessionInfo,
  observation: TerminalObservation,
): JobSnapshot {
  const startedAt = timestamp(terminal.createdAt);
  const providerFinishedAt = terminal.exitedAt === undefined
    ? undefined
    : timestamp(terminal.exitedAt);
  const status = terminal.status;
  const running = status === "running";
  const updatedAt = providerFinishedAt ?? observation.updatedAt;
  return {
    id: terminal.id,
    kind: "terminal",
    label: terminal.name,
    ownerSession: terminal.sessionId!,
    status,
    capabilities: { read: true, wait: true, send: running, cancel: running },
    cwd: terminal.cwd,
    startedAt,
    updatedAt,
    ...(isTerminalJobStatus(status) ? { finishedAt: providerFinishedAt ?? updatedAt } : {}),
  };
}

function readResult(
  result: { data: string; sequence: number; truncated: boolean },
  job: JobSnapshot,
): JobReadResult {
  return {
    text: result.data,
    cursor: result.sequence,
    truncated: result.truncated,
    snapshot: job,
  };
}

function assertOwner(actual: string, expected: string): void {
  if (actual !== expected) throw new Error("Job owner session mismatch.");
}

function timestamp(value: string): number {
  return Date.parse(value);
}

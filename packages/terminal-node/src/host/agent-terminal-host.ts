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

import { LocalTerminalProvider } from "../providers/local-terminal-provider.js";

export interface AgentTerminalProvider extends Pick<
  TerminalProvider,
  "create" | "get" | "list" | "read" | "wait" | "write" | "kill" | "subscribe"
> {
  dispose?(): Promise<void>;
}

export interface CreateAgentTerminalBundleOptions {
  cwd: string;
  sessionId: string;
  provider?: TerminalProvider;
  ownsProvider?: boolean;
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
      return { jobs: filterJobSnapshots(
        terminals.map((terminal) => snapshot(terminal, observationFor(terminal, observations))),
        input,
      ), errors: [] };
    },
    read: async (input) => {
      assertOwner(input.sessionId, options.sessionId);
      await requireOwnedTerminal(provider, input.target.jobId, options.sessionId);
      const result = await provider.read({
        terminalId: input.target.jobId,
        ...(input.after !== undefined ? { after: input.after } : {}),
        ...(input.maxChars !== undefined ? { maxChars: input.maxChars } : {}),
      });
      const terminal = await requireOwnedTerminal(provider, input.target.jobId, options.sessionId);
      return readResult(result, snapshot(terminal, observationFor(terminal, observations)));
    },
    wait: async (input) => {
      assertOwner(input.sessionId, options.sessionId);
      await requireOwnedTerminal(provider, input.target.jobId, options.sessionId);
      const result = await provider.wait({
        terminalId: input.target.jobId,
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
      await requireOwnedTerminal(provider, input.target.jobId, options.sessionId);
      await provider.write({ terminalId: input.target.jobId, data: input.data });
      observationFor(
        await requireOwnedTerminal(provider, input.target.jobId, options.sessionId),
        observations,
      ).updatedAt = Date.now();
    },
    cancel: async (input) => {
      assertOwner(input.sessionId, options.sessionId);
      const terminal = await requireOwnedTerminal(provider, input.target.jobId, options.sessionId);
      const observation = observationFor(terminal, observations);
      await provider.kill(input.target.jobId);
      observation.updatedAt = Date.now();
      return snapshot(
        await requireOwnedTerminal(provider, input.target.jobId, options.sessionId),
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
      if (options.ownsProvider !== false) await (provider as AgentTerminalProvider).dispose?.();
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
    ...(input.command !== undefined ? { command: input.command } : {}),
    cwd: input.cwd,
    source: "agent",
  };
}

async function ownedTerminals(
  provider: Pick<TerminalProvider, "list" | "get">,
  sessionId: string,
): Promise<TerminalSessionInfo[]> {
  return (await provider.list()).filter((terminal) => isOwnedAgentTerminal(terminal, sessionId));
}

async function requireOwnedTerminal(
  provider: Pick<TerminalProvider, "list" | "get">,
  terminalId: string,
  sessionId: string,
): Promise<TerminalSessionInfo> {
  const terminal = await provider.get(terminalId);
  if (!terminal || !isOwnedAgentTerminal(terminal, sessionId)) throw new Error(`Job not found: ${terminalId}`);
  return terminal;
}

function isOwnedAgentTerminal(terminal: TerminalSessionInfo, sessionId: string): boolean {
  return terminal.sessionId === sessionId && terminal.source === "agent";
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
    target: { kind: "terminal", jobId: terminal.id },
    label: terminal.name,
    ownerSession: terminal.sessionId!,
    status,
    capabilities: { read: true, wait: true, send: running, cancel: running },
    cwd: terminal.cwd,
    startedAt,
    updatedAt,
    ...(isTerminalJobStatus(status) ? { finishedAt: providerFinishedAt ?? updatedAt } : {}),
    ...(terminal.exitCode !== undefined ? { exitCode: terminal.exitCode } : {}),
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

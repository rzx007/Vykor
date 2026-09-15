import { resolve } from "node:path";

import type { Settings } from "@openharness/core";
import type {
  ExecutionEnvironmentConsumer,
  ExecutionEnvironmentHandle,
} from "@openharness/environment";
import type {
  AgentTerminalHost,
  TerminalCreateRequest,
  TerminalEventListener,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalResizeRequest,
  TerminalSessionInfo,
  TerminalSignalRequest,
  TerminalSource,
  TerminalWaitRequest,
  TerminalWaitResult,
  TerminalWriteRequest,
} from "@openharness/terminal";
import {
  LocalTerminalProvider,
  type LocalTerminalProviderOptions,
} from "@openharness/terminal-node";
import type { ProjectRecord, SessionRecord } from "@openharness/protocol";
import { ApplicationError } from "../shared/application-error.js";

export interface ListDaemonTerminalsOptions {
  projectId?: string;
  sessionId?: string;
  source?: TerminalSource;
}

export interface DaemonTerminalSessionScopeQueries {
  getProject(projectId: string): ProjectRecord | undefined;
  getSession(sessionId: string): SessionRecord | undefined;
}

export interface DaemonTerminalServiceOptions {
  getSettingsForCwd?(cwd: string): Promise<Settings>;
  acquireEnvironment?(
    session: SessionRecord,
    settings: Settings,
    consumer: ExecutionEnvironmentConsumer,
  ): Promise<ExecutionEnvironmentHandle>;
  spawnPty?: LocalTerminalProviderOptions["spawnPty"];
}

interface ResolvedTerminalRequest {
  scope: NonNullable<TerminalCreateRequest["scope"]>;
  cwd: string;
  projectId?: string;
  session?: SessionRecord;
}

export class DaemonTerminalService {
  private readonly provider: LocalTerminalProvider;

  constructor(
    private readonly store: DaemonTerminalSessionScopeQueries,
    private readonly options: DaemonTerminalServiceOptions = {},
  ) {
    this.provider = new LocalTerminalProvider({
      resolveCwd: async (input) => this.resolveRequest(input).cwd,
      resolveTarget: async (input, _cwd, terminalId) =>
        await this.resolveEnvironmentTarget(input, terminalId),
      spawnPty: options.spawnPty,
    });
  }

  async create(input: TerminalCreateRequest): Promise<TerminalSessionInfo> {
    const resolved = this.resolveRequest(input);
    return await this.provider.create({
      ...input,
      scope: resolved.scope,
      projectId: resolved.projectId,
      sessionId: resolved.session?.id,
      source: input.source ?? "user",
    });
  }

  async list(options: ListDaemonTerminalsOptions = {}): Promise<TerminalSessionInfo[]> {
    return (await this.provider.list()).filter((terminal) => {
      if (options.projectId && terminal.projectId !== options.projectId) return false;
      if (options.sessionId && terminal.sessionId !== options.sessionId) return false;
      if (options.source && terminal.source !== options.source) return false;
      return true;
    });
  }

  async get(terminalId: string): Promise<TerminalSessionInfo> {
    const terminal = (await this.provider.list()).find((item) => item.id === terminalId);
    if (!terminal) throw new DaemonTerminalError(404, `Terminal ${terminalId} does not exist.`);
    return terminal;
  }

  async write(input: TerminalWriteRequest): Promise<void> {
    await this.provider.write(input);
  }

  async resize(input: TerminalResizeRequest): Promise<void> {
    await this.provider.resize(input);
  }

  async read(terminalId: string): Promise<TerminalReadResult> {
    return await this.provider.read({ terminalId });
  }

  async readRequest(input: TerminalReadRequest): Promise<TerminalReadResult> {
    return await this.provider.read(input);
  }

  async wait(input: TerminalWaitRequest): Promise<TerminalWaitResult> {
    return await this.provider.wait(input);
  }

  async signal(input: TerminalSignalRequest): Promise<void> {
    await this.provider.signal(input);
  }

  async close(terminalId: string): Promise<void> {
    await this.get(terminalId);
    await this.provider.kill(terminalId);
  }

  subscribe(listener: TerminalEventListener): () => void {
    return this.provider.subscribe(listener);
  }

  createAgentHost(rootSession: SessionRecord): AgentTerminalHost {
    return {
      open: async (input) => await this.create({
        scope: { kind: "session", sessionId: rootSession.id },
        runtime: "environment",
        cols: input.cols ?? 100,
        rows: input.rows ?? 30,
        name: input.name ?? "Agent terminal",
        shell: input.shell,
        cwd: input.cwd,
        source: "agent",
      }),
    };
  }

  async dispose(): Promise<void> {
    await this.provider.dispose();
  }

  private resolveRequest(input: TerminalCreateRequest): ResolvedTerminalRequest {
    const scope = input.scope ?? (
      input.sessionId
        ? { kind: "session" as const, sessionId: input.sessionId }
        : input.projectId
          ? { kind: "project" as const, projectId: input.projectId }
          : undefined
    );
    if (!scope) throw new DaemonTerminalError(400, "Terminal scope is required.");

    let cwd: string;
    let projectId: string | undefined;
    let session: SessionRecord | undefined;
    if (scope.kind === "session") {
      session = this.store.getSession(scope.sessionId);
      if (!session) throw new DaemonTerminalError(404, `Session not found: ${scope.sessionId}`);
      projectId = session.projectId;
      if (input.sessionId && input.sessionId !== session.id) {
        throw new DaemonTerminalError(400, `Terminal sessionId does not match scope ${scope.sessionId}.`);
      }
      if (input.projectId && session.projectId !== input.projectId) {
        throw new DaemonTerminalError(
          400,
          `Session ${session.id} does not belong to project ${input.projectId}.`,
        );
      }
      cwd = session.cwd;
    } else {
      projectId = scope.projectId;
      const project = this.store.getProject(projectId);
      if (!project) throw new DaemonTerminalError(404, `Project not found: ${projectId}`);
      cwd = project.path;
      if (input.sessionId) {
        session = this.store.getSession(input.sessionId);
        if (!session || session.projectId !== projectId) {
          throw new DaemonTerminalError(400, `Session ${input.sessionId} does not belong to project ${projectId}.`);
        }
        if (resolve(session.cwd) !== resolve(cwd)) {
          throw new DaemonTerminalError(400, "Terminal session and project cwd do not match.");
        }
      }
    }
    if (input.cwd && resolve(input.cwd) !== resolve(cwd)) {
      throw new DaemonTerminalError(400, "Terminal cwd does not match its trusted scope.");
    }
    return {
      scope,
      cwd,
      ...(projectId ? { projectId } : {}),
      ...(session ? { session } : {}),
    };
  }

  private async resolveEnvironmentTarget(input: TerminalCreateRequest, terminalId: string) {
    if (!this.options.getSettingsForCwd || !this.options.acquireEnvironment) {
      throw new DaemonTerminalError(503, "Sandbox terminal environment is not configured.");
    }
    const resolved = this.resolveRequest(input);
    const session = resolved.session ?? ({
      id: `terminal:${terminalId}`,
      cwd: resolved.cwd,
      ...(resolved.projectId ? { projectId: resolved.projectId } : {}),
    } as SessionRecord);
    const settings = await this.options.getSettingsForCwd(resolved.cwd);
    const lease = await this.options.acquireEnvironment(
      session,
      settings,
      { kind: "terminal", id: terminalId },
    );
    try {
      const target = await lease.terminal.prepare({
        cwd: lease.workspace.executionRoot,
        shell: input.shell,
        owner: { kind: "terminal", id: terminalId },
        cols: input.cols,
        rows: input.rows,
      });
      let closed = false;
      return {
        ...target,
        close: async () => {
          if (closed) return;
          closed = true;
          try {
            await target.close();
          } finally {
            await lease.release();
          }
        },
      };
    } catch (error) {
      await lease.release();
      throw error;
    }
  }
}

export class DaemonTerminalError extends ApplicationError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = "DaemonTerminalError";
  }
}

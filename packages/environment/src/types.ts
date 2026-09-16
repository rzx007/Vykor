import type { ShellDescriptor } from "./shell-descriptor.js";

export type ExecutionEnvironmentKind = "local" | "wsl";

export interface WorkspaceBinding {
  kind: ExecutionEnvironmentKind;
  hostRoot: string;
  executionRoot: string;
}

export type EnvironmentPathOperation = "read" | "write" | "execute";
export type EnvironmentMountMode = "ro" | "rw";

export interface EnvironmentMount {
  path: string;
  mode: EnvironmentMountMode;
  purpose: "workspace" | "user_skills" | string;
}

export interface ResolvedEnvironmentPath {
  executionPath: string;
  hostPath?: string;
  mountPurpose: "workspace" | "user_skills" | "unmounted";
  mountMode?: EnvironmentMountMode;
}

export interface EffectiveEnvironmentInfo {
  kind: ExecutionEnvironmentKind;
  hostOs: string;
  executionOs: string;
  shell: string;
  shellDialect: "powershell" | "cmd" | "posix";
  pathStyle: "windows" | "posix";
  cwd: string;
  homeDir: string;
  tempDir: string;
  mounts: EnvironmentMount[];
  networkMode: string;
  git?: { repository: boolean; branch?: string };
  limitations: string[];
  shellDescriptor: ShellDescriptor;
}

export interface EnvironmentProcessResult {
  exitCode: number | null;
  signal?: string;
}

export interface EnvironmentProcess {
  readonly pid?: number;
  write(data: string | Uint8Array): void;
  end(): void;
  onOutput(listener: (chunk: Uint8Array) => void): () => void;
  onErrorOutput?(listener: (chunk: Uint8Array) => void): () => void;
  wait(): Promise<EnvironmentProcessResult>;
  signal(signal: "interrupt" | "terminate"): Promise<void>;
}

export interface EnvironmentProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
  owner?: EnvironmentExecutionOwner;
  signal?: AbortSignal;
}

export interface EnvironmentExecutionOwner {
  kind: "agent" | "terminal" | "background" | "hook" | "mcp";
  id: string;
}

export interface EnvironmentProcessExecutor {
  execShell(
    command: string,
    options?: EnvironmentProcessOptions,
  ): Promise<EnvironmentProcess>;
  execProcess(
    argv: string[],
    options?: EnvironmentProcessOptions,
  ): Promise<EnvironmentProcess>;
}

export interface EnvironmentTerminalPrepareOptions {
  cwd?: string;
  shell?: string;
  owner?: EnvironmentExecutionOwner;
  cols: number;
  rows: number;
}

export interface EnvironmentPtyTarget {
  command: string;
  args: string[];
  hostCwd: string;
  executionCwd: string;
  shell: string;
  env?: Record<string, string>;
  resize?(cols: number, rows: number): Promise<void>;
  signal(signal: "interrupt" | "terminate"): Promise<void>;
  close(): Promise<void>;
}

export interface EnvironmentTerminalFactory {
  prepare(input: EnvironmentTerminalPrepareOptions): Promise<EnvironmentPtyTarget>;
}

export interface EnvironmentFileStat {
  isFile: boolean;
  isDirectory: boolean;
}

export interface EnvironmentFileEntry {
  name: string;
  isDirectory: boolean;
}

export interface EnvironmentGrepOptions {
  include?: string;
  caseSensitive: boolean;
  limit: number;
}

export interface EnvironmentFileSystem {
  stat(path: string): Promise<EnvironmentFileStat>;
  listDir(path: string): Promise<EnvironmentFileEntry[]>;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  writeText(path: string, content: string): Promise<void>;
  writeBytes(path: string, content: Uint8Array): Promise<void>;
  glob(basePath: string, pattern: string, limit: number): Promise<string[]>;
  grep(
    basePath: string,
    pattern: string,
    options: EnvironmentGrepOptions,
  ): Promise<string[]>;
}

export interface EnvironmentPathResolver {
  resolve(
    path: string,
    operation: EnvironmentPathOperation,
  ): Promise<ResolvedEnvironmentPath>;
  presentHostPath(path: string): string | undefined;
  toHostPath(path: string): string | undefined;
}

export interface ExecutionEnvironmentHandle {
  readonly info: EffectiveEnvironmentInfo;
  readonly workspace: WorkspaceBinding;
  readonly process: EnvironmentProcessExecutor;
  readonly terminal: EnvironmentTerminalFactory;
  readonly files: EnvironmentFileSystem;
  readonly paths: EnvironmentPathResolver;
  release(): Promise<void>;
}

export type ExecutionEnvironmentConsumerKind = "agent" | "terminal" | "background";

export interface ExecutionEnvironmentConsumer {
  kind: ExecutionEnvironmentConsumerKind;
  id: string;
}

export type ToolExecutionDomain = "environment" | "control_plane";

export function createWorkspaceBinding(
  binding: WorkspaceBinding,
): WorkspaceBinding {
  if (!binding.hostRoot.trim() || !binding.executionRoot.trim()) {
    throw new Error("Workspace roots must be non-empty");
  }
  if (binding.kind === "wsl") {
    if (
      !binding.executionRoot.startsWith("/") ||
      binding.executionRoot.includes("\\")
    ) {
      throw new Error(
        "WSL execution root must be an absolute POSIX path",
      );
    }
  } else if (
    comparableLocalPath(binding.hostRoot) !==
      comparableLocalPath(binding.executionRoot)
  ) {
    throw new Error("Local workspace roots must match");
  }
  return { ...binding };
}

function comparableLocalPath(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  return /^[a-zA-Z]:[\\/]/.test(trimmed)
    ? trimmed.replace(/\\/g, "/").toLowerCase()
    : trimmed;
}

import type { ChildProcess } from "node:child_process";
import {
  classifySandboxFailure,
  createShellProcess,
  resolveSandboxPolicy,
  resolveHostShellLauncher,
  SandboxUnavailableError,
  signalProcessTree,
  type CreateShellProcessOptions,
  type HostShellLauncher,
  type SandboxPolicy,
} from "@vykor/sandbox";
import { DEFAULT_MAX_OUTPUT_CHARS, looksLikeUtf16Le } from "./output.js";
import { StringDecoder } from "node:string_decoder";
import type {
  ShellExecContext,
  ShellExecRequest,
  ShellExecSpec,
  ShellExecutor,
  ShellRunResult,
  ShellRunnerError,
  ShellRunnerSpec,
} from "./types.js";

export const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
const TIMEOUT_GRACE_MS = 2_000;

type ShellProcessFactory = (
  command: string,
  options: CreateShellProcessOptions,
) => Promise<ChildProcess>;

export interface DefaultShellExecutorDependencies {
  createProcess?: ShellProcessFactory;
  resolveHostShell?: () => HostShellLauncher;
  killProcessTree?: (child: ChildProcess) => void;
}

export class DefaultShellExecutor implements ShellExecutor {
  private readonly createProcess: ShellProcessFactory;
  private readonly resolveHostShell: NonNullable<DefaultShellExecutorDependencies["resolveHostShell"]>;
  private readonly killProcessTree: NonNullable<DefaultShellExecutorDependencies["killProcessTree"]>;

  constructor(dependencies: DefaultShellExecutorDependencies = {}) {
    this.createProcess = dependencies.createProcess ?? createShellProcess;
    this.resolveHostShell = dependencies.resolveHostShell ?? resolveHostShellLauncher;
    this.killProcessTree = dependencies.killProcessTree ?? ((child) => signalProcessTree(child, "SIGKILL"));
  }

  async resolve(request: ShellExecRequest, context: ShellExecContext): Promise<ShellExecSpec> {
    const cwd = request.workdir ?? context.cwd;
    const policy = context.policy ?? resolveSandboxPolicy({
      cwd,
      sessionId: context.sessionId,
      settings: context.settings,
    });

    return {
      command: request.command,
      cwd,
      timeoutMs: request.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS,
      maxOutputChars: request.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
      env: request.env,
      sessionId: context.sessionId,
      settings: context.settings,
      policy,
      hostShell: this.resolveHostShell(),
      runner: resolveRunner(policy),
    };
  }

  run(spec: ShellExecSpec, signal?: AbortSignal, onOutput?: (text: string) => void): Promise<ShellRunResult> {
    return new Promise<ShellRunResult>((resolve) => {
      let child: ChildProcess | undefined;
      let output = "";
      let outputTruncated = false;
      let settled = false;
      let timedOut = false;
      let interrupted = false;
      let runnerError: ShellRunnerError | undefined;
      let executionFailureKind: "runner" | "policy" = "runner";
      let timer: NodeJS.Timeout | undefined;
      let graceTimer: NodeJS.Timeout | undefined;
      const stdout = new ShellStreamDecoder();
      const stderr = new ShellStreamDecoder();

      const append = (decoded: string) => {
        if (!decoded) return;
        onOutput?.(decoded);
        const retainedLimit = spec.maxOutputChars + 1;
        const available = Math.max(0, retainedLimit - output.length);
        if (decoded.length > available) outputTruncated = true;
        if (available > 0) output += decoded.slice(0, available);
        if (output.length > spec.maxOutputChars) outputTruncated = true;
      };

      const finish = (exitCode: number | null) => {
        if (settled) return;
        append(stdout.end());
        append(stderr.end());
        settled = true;
        if (timer) clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        signal?.removeEventListener("abort", interrupt);
        resolve(createRunResult({
          output,
          outputTruncated,
          exitCode,
          timedOut,
          interrupted,
          runnerError,
          executionFailureKind,
        }));
      };

      const interrupt = () => {
        if (settled) return;
        interrupted = true;
        if (!child) {
          finish(null);
          return;
        }
        this.killProcessTree(child);
        child.stdout?.pause();
        child.stderr?.pause();
        finish(child.exitCode);
      };

      if (signal?.aborted) {
        interrupt();
        return;
      }
      signal?.addEventListener("abort", interrupt, { once: true });

      this.createProcess(spec.command, {
        cwd: spec.cwd,
        sessionId: spec.sessionId,
        settings: spec.settings,
        policy: spec.policy,
        env: spec.env,
        stdio: ["ignore", "pipe", "pipe"],
      }).then((startedChild) => {
        child = startedChild;
        if (signal?.aborted || settled) {
          this.killProcessTree(startedChild);
          return;
        }

        startedChild.stdout?.on("data", (chunk: Buffer | string) => append(stdout.write(chunk)));
        startedChild.stderr?.on("data", (chunk: Buffer | string) => append(stderr.write(chunk)));

        timer = setTimeout(() => {
          timedOut = true;
          this.killProcessTree(startedChild);
          graceTimer = setTimeout(() => {
            startedChild.stdout?.pause();
            startedChild.stderr?.pause();
            finish(startedChild.exitCode);
          }, TIMEOUT_GRACE_MS);
          graceTimer.unref?.();
        }, spec.timeoutMs);

        startedChild.on("error", (error) => {
          executionFailureKind = "runner";
          runnerError = serializeRunnerError(error);
          append(`${error.message}\n`);
          finish(null);
        });

        startedChild.on("close", (code) => {
          finish(code);
        });
      }).catch((error) => {
        if (settled) return;
        executionFailureKind = classifySandboxFailure(error) ?? "runner";
        runnerError = serializeRunnerError(error);
        append(runnerError.message);
        finish(null);
      });
    });
  }
}

class ShellStreamDecoder {
  private decoder?: StringDecoder;
  private pending = Buffer.alloc(0);

  write(chunk: Buffer | string): string {
    if (typeof chunk === "string") return this.end() + chunk;
    if (!this.decoder) {
      this.pending = Buffer.concat([this.pending, chunk]);
      if (this.pending.length < 4) return "";
      this.decoder = new StringDecoder(looksLikeUtf16Le(this.pending) ? "utf16le" : "utf8");
      const bytes = this.pending;
      this.pending = Buffer.alloc(0);
      return this.decoder.write(bytes);
    }
    return this.decoder.write(chunk);
  }

  end(): string {
    if (!this.decoder && this.pending.length) {
      this.decoder = new StringDecoder(looksLikeUtf16Le(this.pending) ? "utf16le" : "utf8");
    }
    const result = (this.decoder?.write(this.pending) ?? "") + (this.decoder?.end() ?? "");
    this.pending = Buffer.alloc(0);
    return result;
  }
}

export const defaultShellExecutor: ShellExecutor = new DefaultShellExecutor();

function resolveRunner(
  policy: SandboxPolicy,
): ShellRunnerSpec {
  if (!policy.enabled) {
    return { mode: "host", fallbackToHost: false };
  }
  return {
    mode: policy.failClosed ? "sandbox-required" : "sandbox-preferred",
    backend: policy.backend,
    fallbackToHost: !policy.failClosed,
  };
}

function createRunResult(input: {
  output: string;
  outputTruncated: boolean;
  exitCode: number | null;
  timedOut: boolean;
  interrupted: boolean;
  runnerError?: ShellRunnerError;
  executionFailureKind: "runner" | "policy";
}): ShellRunResult {
  if (input.interrupted) {
    return {
      status: "interrupted",
      failureKind: "interrupted",
      output: input.output,
      outputTruncated: input.outputTruncated,
      exitCode: input.exitCode,
    };
  }
  if (input.timedOut) {
    return {
      status: "timed_out",
      failureKind: "timeout",
      output: input.output,
      outputTruncated: input.outputTruncated,
      exitCode: input.exitCode,
    };
  }
  if (input.runnerError) {
    return {
      status: "failed",
      failureKind: input.executionFailureKind,
      output: input.output,
      outputTruncated: input.outputTruncated,
      exitCode: input.exitCode,
      runnerError: input.runnerError,
    };
  }
  if (input.exitCode !== 0) {
    return {
      status: "failed",
      failureKind: "command",
      output: input.output,
      outputTruncated: input.outputTruncated,
      exitCode: input.exitCode,
    };
  }
  return {
    status: "completed",
    output: input.output,
    outputTruncated: input.outputTruncated,
    exitCode: input.exitCode,
  };
}

function serializeRunnerError(error: unknown): ShellRunnerError {
  if (error instanceof SandboxUnavailableError) {
    return { name: error.name, message: error.message };
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}

import type { IOType } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import process from "node:process";
import { PassThrough, type Stream } from "node:stream";
import type { Settings } from "@vykor/core";
import type { EnvironmentProcess, EnvironmentProcessExecutor } from "@vykor/environment";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { createProcess, type SandboxPolicy } from "@vykor/sandbox";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  getDefaultEnvironment,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";

export interface SandboxStdioClientTransportOptions extends StdioServerParameters {
  settings?: Settings;
  sessionId?: string;
  policy?: SandboxPolicy;
  processExecutor?: EnvironmentProcessExecutor;
}

/**
 * MCP stdio transport that starts the server through Vykor' process
 * factory, so local SRT and execution-environment rules apply to MCP servers too.
 */
export class SandboxStdioClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private process?: ChildProcess;
  private readonly readBuffer = new ReadBuffer();
  private readonly stderrStream: PassThrough | null;

  constructor(private readonly options: SandboxStdioClientTransportOptions) {
    this.stderrStream = options.stderr === "pipe" || options.stderr === "overlapped"
      ? new PassThrough()
      : null;
  }

  async start(): Promise<void> {
    if (this.process) {
      throw new Error("SandboxStdioClientTransport already started");
    }
    const cwd = this.options.cwd ?? process.cwd();
    const env = {
      ...getDefaultEnvironment(),
      ...this.options.env,
    };
    const stderr = this.stderrStream ? "pipe" : this.options.stderr ?? "inherit";
    const argv = [this.options.command, ...(this.options.args ?? [])];
    const child = this.options.processExecutor
      ? adaptEnvironmentProcess(await this.options.processExecutor.execProcess(argv, { cwd, env }))
      : await createProcess(argv, {
        cwd,
        settings: this.options.settings,
        sessionId: this.options.sessionId,
        policy: this.options.policy,
        env,
        stdio: ["pipe", "pipe", stderr as IOType],
        detached: false,
      });
    this.process = child;

    await new Promise<void>((resolve, reject) => {
      let started = false;
      const resolveStarted = () => {
        if (started) return;
        started = true;
        resolve();
      };
      const rejectStarted = (error: Error) => {
        if (started) return;
        started = true;
        reject(error);
      };

      child.once("error", (error: Error) => {
        rejectStarted(error);
        this.onerror?.(error);
      });
      child.once("spawn", resolveStarted);
      child.on("close", (code, signal) => {
        this.process = undefined;
        if (!started) {
          rejectStarted(new Error(`MCP stdio process exited before startup: code=${code ?? "null"} signal=${signal ?? "null"}`));
        }
        this.onclose?.();
      });
      child.stdin?.on("error", (error: Error) => this.onerror?.(error));
      child.stdout?.on("data", (chunk: Buffer | string) => {
        this.readBuffer.append(Buffer.from(chunk));
        this.processReadBuffer();
      });
      child.stdout?.on("error", (error: Error) => this.onerror?.(error));
      if (this.stderrStream && child.stderr) child.stderr.pipe(this.stderrStream);
      setImmediate(() => {
        if (child.pid !== undefined) resolveStarted();
      });
    });
  }

  get stderr(): Stream | null {
    return this.stderrStream ?? this.process?.stderr ?? null;
  }

  get pid(): number | null {
    return this.process?.pid ?? null;
  }

  async close(): Promise<void> {
    if (this.process) {
      const processToClose = this.process;
      this.process = undefined;
      const closePromise = new Promise<void>((resolve) => {
        processToClose.once("close", () => resolve());
      });
      try {
        processToClose.stdin?.end();
      } catch {
        // ignore
      }
      await Promise.race([closePromise, sleep(2_000)]);
      if (processToClose.exitCode === null) {
        try {
          processToClose.kill("SIGTERM");
        } catch {
          // ignore
        }
        await Promise.race([closePromise, sleep(2_000)]);
      }
      if (processToClose.exitCode === null) {
        try {
          processToClose.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }
    this.readBuffer.clear();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.process?.stdin) throw new Error("Not connected");
    const json = serializeMessage(message);
    await new Promise<void>((resolve) => {
      if (this.process!.stdin!.write(json)) resolve();
      else this.process!.stdin!.once("drain", resolve);
    });
  }

  private processReadBuffer(): void {
    while (true) {
      try {
        const message = this.readBuffer.readMessage();
        if (message === null) break;
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}

function adaptEnvironmentProcess(process: EnvironmentProcess): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const mutable = child as unknown as { pid?: number; exitCode: number | null; killed: boolean };
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      try { process.write(chunk); callback(); } catch (error) { callback(error as Error); }
    },
    final(callback) { process.end(); callback(); },
  });
  mutable.pid = process.pid;
  mutable.exitCode = null;
  mutable.killed = false;
  child.kill = (() => { mutable.killed = true; void process.signal("terminate"); return true; }) as ChildProcess["kill"];
  const stop = process.onOutput((chunk) => stdout.write(chunk));
  const stopErrors = process.onErrorOutput?.((chunk) => stderr.write(chunk));
  queueMicrotask(() => child.emit("spawn"));
  void process.wait().then((result) => {
    stop();
    stopErrors?.();
    mutable.exitCode = result.exitCode;
    stdout.end();
    stderr.end();
    child.emit("close", result.exitCode, result.signal ?? null);
  }).catch((error) => {
    stop();
    stopErrors?.();
    child.emit("error", error);
    child.emit("close", 1, null);
  });
  return child;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

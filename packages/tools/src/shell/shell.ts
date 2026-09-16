import type { ToolDefinition } from "@openharness/core";
import {
  shellResultMetadata,
  type ShellDescriptor,
} from "@openharness/environment";
import {
  describeHostShellLauncher,
  resolveHostShellLauncher,
  type HostShellLauncher,
} from "@openharness/sandbox";
import { defaultShellExecutor } from "./executor.js";
import { formatOutput } from "./output.js";
import type { ShellExecSpec, ShellExecutor } from "./types.js";

export { decodeShellChunk, formatOutput, looksLikeUtf16Le } from "./output.js";

export function createShellTool(
  shellOrExecutor?: ShellDescriptor | ShellExecutor,
  executor: ShellExecutor = defaultShellExecutor,
): ToolDefinition {
  const shell = isShellExecutor(shellOrExecutor) ? undefined : shellOrExecutor;
  const effectiveExecutor = isShellExecutor(shellOrExecutor) ? shellOrExecutor : executor;
  return {
    name: "Shell",
    description: createShellDescription(shell),
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute." },
        timeout: {
          type: "number",
          description: "Optional timeout in milliseconds.",
        },
        workdir: {
          type: "string",
          description: "Working directory for the command.",
        },
      },
      required: ["command"],
    },
    async execute(input, context) {
      const command = typeof input.command === "string" ? input.command.trim() : "";
      const hasExplicitTimeout = input.timeout !== undefined;
      if (command && !hasExplicitTimeout && shouldCreateBackgroundShell(command, context)) {
        try {
          const requestedCwd = typeof input.workdir === "string" && input.workdir.trim()
            ? input.workdir.trim()
            : context.cwd;
          const backgroundCwd = context.environment
            ? context.environment.paths.toHostPath(requestedCwd)
            : requestedCwd;
          if (!backgroundCwd) {
            throw new Error(`Background shell workdir is outside the mounted execution roots: ${requestedCwd}`);
          }
          const created = await context.backgroundShell!.create({
            requestId: `tool:${context.toolCallId}`,
            command,
            description: summarizeCommand(command),
            cwd: backgroundCwd,
            sessionId: context.sessionId!,
            settings: context.settings,
            ...(shell ? { shellDescriptor: shell } : {}),
          });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                kind: "job",
                action: "created",
                jobId: created.jobId,
                jobKind: "shell",
                label: created.label,
                note: "Shell was converted to a background job because the command looks long-running. Use JobWait for bounded progress or JobRead for output snapshots.",
              }),
            }],
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            isError: true,
          };
        }
      }
      if (context.environment) {
        return await executeInEnvironment(command, input, context);
      }

      const spec = await effectiveExecutor.resolve({
        command: input.command as string,
        timeoutMs: input.timeout as number | undefined,
        workdir: input.workdir as string | undefined,
      }, {
        cwd: context.cwd,
        sessionId: context.sessionId,
        settings: context.settings,
      });
      const dialectMismatch = diagnoseShellCommand(spec);
      if (dialectMismatch) {
        return {
          content: [{ type: "text", text: formatShellDialectMismatch(dialectMismatch) }],
          isError: true,
        };
      }

      const result = await effectiveExecutor.run(spec, context.abortSignal);
      if (result.status === "interrupted") {
        return {
          content: [{ type: "text", text: formatInterruptedOutput(result.output, spec.maxOutputChars) }],
          isError: true,
        };
      }
      if (result.status === "timed_out") {
        return {
          content: [{
            type: "text",
            text: formatTimeoutOutput(result.output, spec.timeoutMs, spec.maxOutputChars),
          }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: formatOutput(result.output, spec.maxOutputChars) }],
        isError: result.status === "failed",
      };
    },
  };
}

async function executeInEnvironment(
  command: string,
  input: Record<string, unknown>,
  context: Parameters<ToolDefinition["execute"]>[1],
) {
  if (!command) {
    return { content: [{ type: "text" as const, text: "command is required" }], isError: true };
  }
  const environment = context.environment!;
  const descriptor = environment.info.shellDescriptor;
  const shell = descriptorHostLauncher(descriptor);
  const problems = diagnoseShellDialectMismatch(command, shell);
  if (problems.length > 0) {
    return {
      content: [{
        type: "text" as const,
        text: formatShellDialectMismatch({ shell, problems }),
      }],
      isError: true,
      failureKind: "command" as const,
      metadata: shellResultMetadata(descriptor, null, "failed"),
    };
  }
  const rawWorkdir = typeof input.workdir === "string" && input.workdir.trim()
    ? input.workdir.trim()
    : environment.workspace.executionRoot;
  const resolved = await environment.paths.resolve(rawWorkdir, "execute");

  const timeoutMs = typeof input.timeout === "number" ? input.timeout : 120_000;
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  context.abortSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let output = "";
  try {
    const process = await environment.process.execShell(command, {
      cwd: resolved.executionPath,
      signal: controller.signal,
    });
    const stopListening = process.onOutput((chunk) => {
      output = (output + new TextDecoder().decode(chunk)).slice(-12_000);
    });
    const stopErrors = process.onErrorOutput?.((chunk) => {
      output = (output + new TextDecoder().decode(chunk)).slice(-12_000);
    });
    try {
      const result = await process.wait();
      const formatted = formatOutput(output, 12_000);
      if (timedOut) {
        return {
          content: [{ type: "text" as const, text: formatTimeoutOutput(output, timeoutMs, 12_000) }],
          isError: true,
          metadata: shellResultMetadata(descriptor, result.exitCode, "timed_out"),
        };
      }
      if (context.abortSignal?.aborted) {
        return {
          content: [{ type: "text" as const, text: formatInterruptedOutput(output, 12_000) }],
          isError: true,
          metadata: shellResultMetadata(descriptor, result.exitCode, "interrupted"),
        };
      }
      return {
        content: [{ type: "text" as const, text: formatted }],
        isError: result.exitCode !== 0,
        metadata: shellResultMetadata(
          descriptor,
          result.exitCode,
          result.exitCode === 0 ? "completed" : "failed",
        ),
      };
    } finally {
      stopListening();
      stopErrors?.();
    }
  } catch (error) {
    return {
      content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
      isError: true,
      metadata: shellResultMetadata(descriptor, null, "failed"),
    };
  } finally {
    clearTimeout(timer);
    context.abortSignal?.removeEventListener("abort", abort);
  }
}

function isShellExecutor(value: ShellDescriptor | ShellExecutor | undefined): value is ShellExecutor {
  return Boolean(value && "resolve" in value && "run" in value);
}

function descriptorHostLauncher(descriptor: ShellDescriptor): HostShellLauncher {
  if (descriptor.family === "powershell") return { kind: "powershell", bin: descriptor.executable };
  if (descriptor.family === "cmd") return { kind: "cmd", bin: descriptor.executable };
  return descriptor.dialect === "bash"
    ? { kind: "bash", bin: descriptor.executable }
    : { kind: "posix-sh" };
}

export const shellTool: ToolDefinition = createShellTool();

export function createShellDescription(shell?: ShellDescriptor): string {
  const background = "For long-running commands such as dev servers, watchers, installs, builds, migrations, docker compose, or commands likely to take more than a brief moment, use BackgroundShellCreate and then JobWait or JobRead.";
  if (!shell) return `Execute a short-lived command using the execution environment's resolved shell. ${background}`;
  if (shell.dialect === "windows-powershell") {
    return `Execute a short-lived command with ${shell.displayName}. Use PowerShell syntax and Windows paths. Prefer native PowerShell pipelines such as Get-Content -Raw -Encoding UTF8 -LiteralPath and ConvertFrom-Json for object and JSON processing. ConvertFrom-Json does not support -Depth in Windows PowerShell 5.1. Use curl.exe when the native curl executable is intended. Avoid embedding multiline programs in python -c. Do not use Bash heredoc syntax; use a PowerShell here-string piped to python - when multiline Python is unavoidable. ${background}`;
  }
  if (shell.dialect === "pwsh") {
    return `Execute a short-lived command with ${shell.displayName}. Use PowerShell syntax and ${shell.pathStyle} paths. Prefer native PowerShell pipelines such as Get-Content -Raw -LiteralPath and ConvertFrom-Json for object and JSON processing. PowerShell 7 supports && and ||. Avoid embedding multiline programs in python -c. Do not use Bash heredoc syntax. ${background}`;
  }
  if (shell.dialect === "cmd") {
    return `Execute a short-lived command with Command Prompt. Use cmd.exe syntax and Windows paths. ${background}`;
  }
  return `Execute a short-lived command with ${shell.displayName}. Use ${shell.dialect} syntax and POSIX paths. ${background}`;
}

function shouldCreateBackgroundShell(command: string, context: Parameters<ToolDefinition["execute"]>[1]): boolean {
  return Boolean(context.backgroundShell && context.sessionId && context.toolCallId && isLikelyLongRunningCommand(command));
}

function isLikelyLongRunningCommand(command: string): boolean {
  const normalized = command.toLowerCase().replace(/\s+/g, " ").trim();
  return [
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|watch)\b/,
    /\b(?:vite|next|nuxt|astro|webpack|rollup|parcel|tsc)\b.*\b(?:dev|serve|watch|-w|--watch)\b/,
    /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|upgrade|update|ci)\b/,
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|test|lint|typecheck|check-types)\b/,
    /\bdocker\s+compose\s+up\b/,
    /\bdocker-compose\s+up\b/,
    /\b(?:prisma|drizzle|typeorm|sequelize)\b.*\b(?:migrate|generate|studio)\b/,
  ].some((pattern) => pattern.test(normalized));
}

function summarizeCommand(command: string): string {
  const compact = command.replace(/\s+/g, " ").trim();
  return compact.length <= 80 ? compact : `${compact.slice(0, 77)}...`;
}

export interface ShellDialectProblem {
  code: string;
  message: string;
  suggestion: string;
}

export interface ShellDialectMismatch {
  shell: HostShellLauncher;
  problems: ShellDialectProblem[];
}

export function diagnoseShellDialectMismatch(
  command: string,
  shell: HostShellLauncher = resolveHostShellLauncher(),
): ShellDialectProblem[] {
  const checks: Array<{
    code: string;
    pattern: RegExp;
    message: string;
    suggestion: string;
    shells?: ReadonlyArray<HostShellLauncher["kind"]>;
  }> = [
    {
      code: "dev-null",
      pattern: /\/dev\/null\b/i,
      message: "uses `/dev/null`, which is a POSIX null device path.",
      suggestion: shell.kind === "powershell" ? "Use `$null` in PowerShell." : "Use `NUL` in cmd.exe.",
      shells: ["powershell", "cmd"],
    },
    {
      code: "posix-temp-path",
      pattern: /(^|[\s"'=])\/tmp(?:\/|\b)/i,
      message: "uses `/tmp`, which is a POSIX temp path.",
      suggestion: shell.kind === "powershell" ? "Use `$env:TEMP` or a Windows path." : "Use `%TEMP%` or a Windows path.",
      shells: ["powershell", "cmd"],
    },
    {
      code: "posix-root-path",
      pattern: /(^|[\s"'=])\/(?:home|mnt|var|etc|usr|bin)(?:\/|\b)/i,
      message: "uses an absolute POSIX path.",
      suggestion: "Use the workspace path shown in the Environment section or another confirmed Windows path.",
      shells: ["powershell", "cmd"],
    },
    {
      code: "ls-la",
      pattern: /(^|[;&|]\s*)ls\s+-[A-Za-z]*[al][A-Za-z]*(?:\s|$)/,
      message: "uses `ls -la` style flags, which are Bash/POSIX syntax.",
      suggestion: shell.kind === "powershell" ? "Use `Get-ChildItem -Force`." : "Use `dir /a`.",
      shells: ["powershell", "cmd"],
    },
    {
      code: "head",
      pattern: /(^|[;&|]\s*)head(?:\s+-\d+|\s+-n\b|\s|$)/,
      message: "uses `head`, which is not a built-in Windows shell command.",
      suggestion: shell.kind === "powershell" ? "Pipe to `Select-Object -First N`." : "Use a cmd-compatible command or run through bash.exe.",
      shells: ["powershell", "cmd"],
    },
    {
      code: "find-root",
      pattern: /(^|[;&|]\s*)find\s+\/(?:\s|$)/,
      message: "uses POSIX `find /` syntax.",
      suggestion: shell.kind === "powershell" ? "Use `Get-ChildItem -Recurse` from a confirmed directory." : "Use `dir /s` from a confirmed directory.",
      shells: ["powershell", "cmd"],
    },
    {
      code: "cd-root",
      pattern: /(^|[;&|]\s*)cd\s+\/(?:\s|$)/,
      message: "uses `cd /`, which means filesystem root in POSIX shells.",
      suggestion: "Use a Windows drive path such as `C:\\` or the current workspace path.",
      shells: ["powershell", "cmd"],
    },
    {
      code: "bash-heredoc",
      pattern: /(?:^|\s)<<-?\s*['"]?[A-Za-z_][\w-]*['"]?/m,
      message: "uses Bash heredoc syntax.",
      suggestion: shell.kind === "powershell"
        ? "Use a PowerShell here-string piped to the command instead."
        : "Use a cmd-compatible input method.",
      shells: ["powershell", "cmd"],
    },
    {
      code: "powershell-control-operator",
      pattern: /(^|\s)(?:&&|\|\|)(?=\s|$)/,
      message: "uses Bash-style `&&` or `||` command chaining.",
      suggestion: "Use separate PowerShell commands or explicit `if ($LASTEXITCODE -eq 0) { ... }` logic.",
      shells: shell.kind === "powershell"
        && /powershell(?:\.exe)?/i.test(shell.bin)
        && !/pwsh(?:\.exe)?/i.test(shell.bin)
        ? ["powershell"]
        : [],
    },
    {
      code: "cmd-dir-switch",
      pattern: /(^|[;&|]\s*)dir\s+\/[a-z]+(?:\s|$)/i,
      message: "uses cmd.exe-style `dir /...` switches.",
      suggestion: "Use `Get-ChildItem` with PowerShell parameters such as `-Name` or `-Force`.",
      shells: ["powershell"],
    },
    {
      code: "cmd-null-device",
      pattern: /(?:^|\s)\d*>\s*nul(?:\s|$)/i,
      message: "redirects output to the cmd.exe `NUL` device.",
      suggestion: shell.kind === "powershell"
        ? "Use `$null` in PowerShell redirections."
        : "Use `/dev/null` in POSIX shell redirections.",
      shells: ["powershell", "bash", "posix-sh"],
    },
    {
      code: "powershell-cmdlet",
      pattern: /(^|[;&|]\s*)(?:Get-ChildItem|Select-Object|Where-Object|ForEach-Object|Set-Location)(?:\s|$)/i,
      message: "uses a PowerShell cmdlet.",
      suggestion: shell.kind === "cmd"
        ? "Use a cmd.exe built-in or invoke PowerShell explicitly."
        : "Use the corresponding POSIX command.",
      shells: ["cmd", "bash", "posix-sh"],
    },
    {
      code: "powershell-env",
      pattern: /\$env:[A-Za-z_][A-Za-z0-9_]*/i,
      message: "uses PowerShell environment-variable syntax.",
      suggestion: shell.kind === "cmd" ? "Use `%NAME%` in cmd.exe." : "Use `$NAME` in POSIX shells.",
      shells: ["cmd", "bash", "posix-sh"],
    },
    {
      code: "powershell-null",
      pattern: /\$null\b/i,
      message: "uses the PowerShell `$null` value.",
      suggestion: shell.kind === "cmd" ? "Use `NUL` in cmd.exe." : "Use `/dev/null` for POSIX redirection.",
      shells: ["cmd", "bash", "posix-sh"],
    },
  ];

  const problems: ShellDialectProblem[] = [];
  for (const check of checks) {
    if (check.shells && !check.shells.includes(shell.kind)) continue;
    check.pattern.lastIndex = 0;
    if (!check.pattern.test(command)) continue;
    problems.push({
      code: check.code,
      message: check.message,
      suggestion: check.suggestion,
    });
  }
  return problems;
}

function diagnoseShellCommand(
  spec: ShellExecSpec,
): ShellDialectMismatch | null {
  const shell = spec.hostShell;
  const problems = diagnoseShellDialectMismatch(spec.command, shell);
  return problems.length > 0 ? { shell, problems } : null;
}

function formatShellDialectMismatch(mismatch: ShellDialectMismatch): string {
  const lines = [
    `Shell dialect mismatch: the active shell is ${describeHostShellLauncher(mismatch.shell)}, but this command uses syntax from another shell.`,
    "",
    "Problems:",
  ];
  for (const problem of mismatch.problems) {
    lines.push(`- ${problem.message} ${problem.suggestion}`);
  }
  lines.push("", "Rewrite the command using the active shell syntax.");
  return lines.join("\n");
}

function formatTimeoutOutput(raw: string, timeout: number, maxOutputChars: number): string {
  const parts = [`Command timed out after ${timeout} ms.`];
  const text = formatOutput(raw, maxOutputChars);
  if (text !== "(no output)") {
    parts.push("", "Partial output:", text);
  }
  return parts.join("\n");
}

function formatInterruptedOutput(raw: string, maxOutputChars: number): string {
  const parts = ["Command interrupted."];
  const text = formatOutput(raw, maxOutputChars);
  if (text !== "(no output)") {
    parts.push("", "Partial output:", text);
  }
  return parts.join("\n");
}

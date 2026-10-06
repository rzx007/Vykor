import type { ShellOutputLogStatus, ToolDefinition, ToolResult } from "@vykor/core";
import {
  shellResultMetadata,
  type ShellDescriptor,
} from "@vykor/environment";
import {
  describeHostShellLauncher,
  resolveHostShellLauncher,
  type HostShellLauncher,
} from "@vykor/sandbox";
import { defaultShellExecutor } from "./executor.js";
import { createBoundedOutputCollector, DEFAULT_MAX_OUTPUT_CHARS, formatOutput } from "./output.js";
import type { ShellExecutor } from "./types.js";

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
      if (context.abortSignal?.aborted) return interruptedBeforeStart();
      const command = typeof input.command === "string" ? input.command.trim() : "";
      const descriptor = context.environment?.info.shellDescriptor ?? shell;
      const hasExplicitTimeout = input.timeout !== undefined;
      const background = Boolean(command && !hasExplicitTimeout && shouldCreateBackgroundShell(command, context));
      if (background) {
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
          if (context.abortSignal?.aborted) return interruptedBeforeStart();
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
            executionState: "completed",
            compactSummary: `Shell background job created: jobId=${created.jobId}`,
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            isError: true,
            failureKind: "unknown_outcome",
            executionState: "unknown",
          };
        }
      }
      if (context.environment) {
        return withShellDialectHints(await executeInEnvironment(command, input, context), command, descriptorHostLauncher(descriptor!));
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
      if (context.abortSignal?.aborted) return interruptedBeforeStart();

      const output = createBoundedOutputCollector();
      const capture = context.shellOutputLogs?.begin(context.sessionId, spec.maxOutputChars);
      let streamed = false;
      const append = (text: string) => { streamed = true; output.append(text); capture?.append(text); };
      let result: Awaited<ReturnType<ShellExecutor["run"]>>;
      try {
        result = await effectiveExecutor.run(spec, context.abortSignal, append);
      } catch (error) {
        const status = capture?.finish(false);
        return {
          content: shellOutputBlocks(output.value(), status, output.omitted(), !!capture,
            error instanceof Error ? error.message : String(error)),
          isError: true, failureKind: "unknown_outcome", executionState: "unknown",
        };
      }
      if (!streamed) { output.append(result.output); capture?.append(result.output); }
      const rawOutput = output.value();
      const status = capture?.finish((result.status === "completed" || result.failureKind === "command") && result.exitCode !== null && (streamed || !result.outputTruncated));
      const blocks = (text: string) => shellOutputBlocks(text, status, output.omitted() || result.outputTruncated, !!capture);
      if (result.status === "interrupted") {
        return {
          content: blocks(formatInterruptedOutput(rawOutput, spec.maxOutputChars)),
          isError: true,
          failureKind: "interrupted",
          executionState: "unknown",
        };
      }
      if (result.status === "timed_out") {
        return {
          content: blocks(formatTimeoutOutput(rawOutput, spec.timeoutMs, spec.maxOutputChars)),
          isError: true,
          failureKind: "timeout",
          executionState: "unknown",
        };
      }
      return withShellDialectHints({
        content: blocks(formatOutput(rawOutput, spec.maxOutputChars)),
        isError: result.status === "failed" || result.exitCode === null,
        executionState: result.failureKind === "policy" ? "not_started" : result.exitCode === null || result.status === "failed" && result.failureKind !== "command" ? "unknown" : "completed",
        ...(result.status === "failed" || result.exitCode === null ? { failureKind: result.failureKind === "policy" ? "policy" as const : result.failureKind === "command" && result.exitCode !== null ? "command" as const : "unknown_outcome" as const } : {}),
        ...(result.status === "failed" && result.failureKind === "command" && result.exitCode !== null ? { recoveryHint: `命令退出码 ${result.exitCode}；检查输出后诊断原因。` } : {}),
        ...(result.status === "completed" && result.exitCode !== null ? { compactSummary: `Shell completed: exitCode=${result.exitCode}` } : {}),
      }, spec.command, spec.hostShell);
    },
  };
}

async function executeInEnvironment(
  command: string,
  input: Record<string, unknown>,
  context: Parameters<ToolDefinition["execute"]>[1],
) {
  if (!command) {
    return { content: [{ type: "text" as const, text: "command is required" }], isError: true, failureKind: "invalid_input" as const, executionState: "not_started" as const };
  }
  const environment = context.environment!;
  const descriptor = environment.info.shellDescriptor;
  const rawWorkdir = typeof input.workdir === "string" && input.workdir.trim()
    ? input.workdir.trim()
    : environment.workspace.executionRoot;
  const resolved = await environment.paths.resolve(rawWorkdir, "execute");

  const timeoutMs = typeof input.timeout === "number" ? input.timeout : 120_000;
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (context.abortSignal?.aborted) abort();
  else context.abortSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const output = createBoundedOutputCollector();
  const capture = context.shellOutputLogs?.begin(context.sessionId, DEFAULT_MAX_OUTPUT_CHARS);
  const append = (text: string) => { output.append(text); capture?.append(text); };
  const stdoutDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const stderrDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
  try {
    if (controller.signal.aborted) {
      capture?.finish(false);
      return {
        content: [{ type: "text" as const, text: "Shell interrupted before the process started." }],
        isError: true, failureKind: "interrupted" as const, executionState: "not_started" as const,
        metadata: shellResultMetadata(descriptor, null, "interrupted"),
      };
    }
    const process = await environment.process.execShell(command, {
      cwd: resolved.executionPath,
      signal: controller.signal,
    });
    const stopListening = process.onOutput((chunk) => {
      append(stdoutDecoder.decode(chunk, { stream: true }));
    });
    const stopErrors = process.onErrorOutput?.((chunk) => {
      append(stderrDecoder.decode(chunk, { stream: true }));
    });
    try {
      const result = await process.wait();
      append(stdoutDecoder.decode());
      append(stderrDecoder.decode());
      const rawOutput = output.value();
      const formatted = formatOutput(rawOutput, DEFAULT_MAX_OUTPUT_CHARS);
      const status = capture?.finish(!timedOut && !context.abortSignal?.aborted && result.exitCode !== null);
      const blocks = (text: string) => shellOutputBlocks(text, status, output.omitted(), !!capture);
      if (timedOut) {
        return {
          content: blocks(formatTimeoutOutput(rawOutput, timeoutMs, DEFAULT_MAX_OUTPUT_CHARS)),
          isError: true,
          failureKind: "timeout" as const,
          executionState: "unknown" as const,
          metadata: shellResultMetadata(descriptor, result.exitCode, "timed_out"),
        };
      }
      if (context.abortSignal?.aborted) {
        return {
          content: blocks(formatInterruptedOutput(rawOutput, DEFAULT_MAX_OUTPUT_CHARS)),
          isError: true,
          failureKind: "interrupted" as const,
          executionState: "unknown" as const,
          metadata: shellResultMetadata(descriptor, result.exitCode, "interrupted"),
        };
      }
      return {
        content: blocks(formatted),
        isError: result.exitCode !== 0,
        executionState: result.exitCode === null ? "unknown" as const : "completed" as const,
        ...(result.exitCode === null
          ? { failureKind: "unknown_outcome" as const }
          : result.exitCode !== 0
            ? { failureKind: "command" as const, recoveryHint: `命令退出码 ${result.exitCode}；检查输出后诊断原因。` }
            : { compactSummary: `Shell completed: exitCode=${result.exitCode}` }),
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
    append(stdoutDecoder.decode());
    append(stderrDecoder.decode());
    const status = capture?.finish(false);
    return {
      content: shellOutputBlocks(output.value(), status, output.omitted(), !!capture,
        error instanceof Error ? error.message : String(error)),
      isError: true,
      failureKind: "unknown_outcome" as const,
      executionState: "unknown" as const,
      metadata: shellResultMetadata(descriptor, null, "failed"),
    };
  } finally {
    clearTimeout(timer);
    context.abortSignal?.removeEventListener("abort", abort);
  }
}

function shellOutputBlocks(
  preview: string,
  status: ShellOutputLogStatus | undefined,
  omitted: boolean,
  hostPresent: boolean,
  error?: string,
): Array<{ type: "text"; text: string }> {
  const blocks = [{ type: "text" as const, text: error ? `${preview ? `${preview}\n` : ""}${error}` : preview }];
  if (status?.reference) {
    blocks.push({ type: "text", text: `[tool-output-ref: ${status.reference}]` });
    const note = status.discardedBytes > 0
      ? `Shell 日志仅保留前部 ${status.retainedBytes} 字节，后续 ${status.discardedBytes} 字节已丢失。`
      : status.complete ? "预览省略的内容已留存。" : "Shell 日志不完整，已收到的内容仍可补读。";
    blocks.push({ type: "text", text: `${note} 使用 Read(file_path="${status.reference}", cursor=0) 或 Grep(path="${status.reference}", pattern="...")。` });
  } else if (omitted || (status && (status.retainedBytes > 0 || status.discardedBytes > 0))) {
    blocks.push({ type: "text", text: hostPresent
      ? `Shell 日志不可补读${status?.reason ? `：${status.reason}` : ""}；${status?.discardedBytes ? "部分输出已丢失。" : "预览之外的内容可能已丢失。"}`
      : "Shell 日志能力未注入；预览省略的中间内容未保存，无法补读。" });
  }
  return blocks;
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
  const background = "For long-running commands such as dev servers, watchers, installs, builds, migrations, docker compose, or commands likely to take more than a brief moment, use background execution when its tool and visible job controls are available, then follow the returned handle. Do not claim completion without evidence.";
  const powershellQuoting = "This tool already runs PowerShell: execute scripts directly. If another powershell/pwsh process is needed, use a single-quoted -Command script or a script block; double-quoted scripts expand $variables in the outer shell. A here-string opener (@' or @\") must be followed by a newline before any content; put its matching terminator ('@ or \"@) on its own line.";
  if (!shell) return `Execute a short-lived command using the execution environment's resolved shell. ${background}`;
  if (shell.dialect === "windows-powershell") {
    return `Execute a short-lived command with ${shell.displayName}. Use PowerShell syntax and Windows paths. ${powershellQuoting} Prefer native PowerShell pipelines such as Get-Content -Raw -Encoding UTF8 -LiteralPath and ConvertFrom-Json for object and JSON processing. ConvertFrom-Json does not support -Depth in Windows PowerShell 5.1. Use curl.exe when the native curl executable is intended. Avoid embedding multiline programs in python -c. Do not use Bash heredoc syntax; use a PowerShell here-string piped to python - when multiline Python is unavoidable. ${background}`;
  }
  if (shell.dialect === "pwsh") {
    return `Execute a short-lived command with ${shell.displayName}. Use PowerShell syntax and ${shell.pathStyle} paths. ${powershellQuoting} Prefer native PowerShell pipelines such as Get-Content -Raw -LiteralPath and ConvertFrom-Json for object and JSON processing. PowerShell 7 supports && and ||. Avoid embedding multiline programs in python -c. Do not use Bash heredoc syntax. ${background}`;
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

function interruptedBeforeStart(): ToolResult {
  return {
    content: [{ type: "text", text: "Shell interrupted before the command started." }],
    isError: true, failureKind: "interrupted", executionState: "not_started",
  };
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
  if (shell.kind === "powershell") problems.push(...diagnosePowerShellQuoting(command));
  return problems;
}

/** Check the observed quoting mistakes, skipping quoted examples and here-string bodies. */
function diagnosePowerShellQuoting(command: string): ShellDialectProblem[] {
  const problems: ShellDialectProblem[] = [];
  const tokens = /<#[\s\S]*?#>|(?<![^\s;|&({])#[^\r\n]*|@(?<hereQuote>['"])[^\S\r\n]*\r?\n[\s\S]*?^\k<hereQuote>@|(?:\b(?:powershell|pwsh)(?:\.exe)?|"(?:[^"\r\n]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"|'(?:[^'\r\n]*[\\/])?(?:powershell|pwsh)(?:\.exe)?')\s+(?:-(?:NoLogo|NoProfile|NonInteractive)\s+)*-(?:Command|c)\s+"(?<nestedScript>(?:`[\s\S]|""|[^"`])*)"|(?<badHeader>@['"][^\r\n])|'(?:[^']|'')*'|"(?:`[\s\S]|""|[^"`])*"|`[\s\S]/gim;
  for (const token of command.matchAll(tokens)) {
    if (token.groups?.badHeader && !problems.some((problem) => problem.code === "powershell-here-string-header")) {
      problems.push({
        code: "powershell-here-string-header",
        message: "puts content on the opening line of a PowerShell here-string.",
        suggestion: "Insert a newline immediately after @' or @\"; place the matching terminator on its own line.",
      });
    }
    const script = token.groups?.nestedScript;
    if (script !== undefined && [...script.matchAll(/`[\s\S]|(\$(?:[A-Za-z_]|\{|\())/g)].some((match) => match[1])) {
      if (problems.some((problem) => problem.code === "powershell-nested-expansion")) continue;
      problems.push({
        code: "powershell-nested-expansion",
        message: "wraps a variable-containing PowerShell script in a double-quoted -Command argument; the outer shell expands those variables first.",
        suggestion: "Run the script directly in this PowerShell tool, or use a single-quoted -Command script / script block for the child process.",
      });
    }
  }
  return problems;
}

function withShellDialectHints(result: ToolResult, command: string, shell: HostShellLauncher): ToolResult {
  if (result.failureKind !== "command") return result;
  const problems = diagnoseShellDialectMismatch(command, shell);
  if (!problems.length) return result;
  const lines = [
    `Possible shell compatibility hints (active shell: ${describeHostShellLauncher(shell)}).`,
    "These are heuristic suggestions, not confirmed syntax errors; diagnose the actual command output first.",
    "",
  ];
  for (const problem of problems) {
    lines.push(`- ${problem.message} ${problem.suggestion}`);
  }
  return { ...result, content: [...result.content, { type: "text", text: lines.join("\n") }] };
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

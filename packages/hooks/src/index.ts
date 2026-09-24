import type {
  HookEvent,
  HookType,
  HookDefinition,
  HookResult,
  IHookExecutor,
  StreamingMessageClient,
  StreamMessageParams,
  Settings,
} from "@vykor/core";
import { canonicalToolName } from "@vykor/core";
import { createShellProcess } from "@vykor/sandbox";
import type { EnvironmentProcessExecutor } from "@vykor/environment";

export type { HookEvent, HookType, HookDefinition, HookResult };

export interface DetailedHookResult {
  hookId: string;
  success: boolean;
  error?: Error;
  durationMs: number;
}

/** Options for configuring a {@link HookExecutor}. */
export interface HookExecutorOptions {
  /**
   * （可选）用于评估 `prompt`/`agent` 钩子的模型客户端。
   * 如果未提供，则这类钩子类型为非阻塞无操作（no-op）。
   */
  client?: StreamingMessageClient;
  /** 默认模型 ID，当 `prompt`/`agent` 钩子未指定时使用。 */
  defaultModel?: string;
  /** Workspace and runtime identity used by sandbox-aware command hooks. */
  cwd?: string;
  sessionId?: string;
  settings?: Settings;
  processExecutor?: EnvironmentProcessExecutor;
}

/**
 * 将字符串安全地用于 POSIX shell 命令的引号处理，行为与 Python 的 `shlex.quote` 类似。
 * 用单引号包裹字符串，并对嵌入的单引号进行转义。
 * 
 * @param value - 需要转义的字符串值
 * @returns 转义后的安全字符串，可直接用于POSIX shell命令中
 */
function shellQuote(value: string): string {
  // 处理空字符串的特殊情况
  if (value === "") return "''";

  // 如果只包含安全字符，无需转义
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;

  // 用单引号包裹字符串，并转义其中嵌入的单引号
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** 将序列化的负载注入 `$ARGUMENTS` 占位符。 */
function injectArguments(
  template: string,
  payload: Record<string, unknown>,
  shellEscape = false
): string {
  let serialized = JSON.stringify(payload);
  if (shellEscape) {
    serialized = shellQuote(serialized);
  }
  return template.split("$ARGUMENTS").join(serialized);
}

/**
 * 实现 fnmatch/glob 风格的字符串匹配（与 Python 的 `fnmatch` 语义类似）。
 * 支持通配符：`*`（任意字符任意长度），`?`（任意单个字符），`[seq]`（字符集）。
 * 匹配不区分大小写，但与 Python 在区分大小写平台的行为不完全一致。
 */
function fnmatch(name: string, pattern: string): boolean {
  // 将模式转换为正则表达式
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*") {
      re += ".*";
    } else if (c === "?") {
      re += ".";
    } else if (c === "[") {
      let j = i + 1;
      if (pattern[j] === "!") j++;
      if (pattern[j] === "]") j++;
      while (j < pattern.length && pattern[j] !== "]") j++;
      if (j >= pattern.length) {
        re += "\\[";
      } else {
        let stuff = pattern.slice(i + 1, j).replace(/\\/g, "\\\\");
        i = j;
        if (stuff.startsWith("!")) stuff = "^" + stuff.slice(1);
        re += `[${stuff}]`;
      }
    } else {
      re += c.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`).test(name);
}

/** Resolve the subject string a matcher is tested against, mirroring Python. */
function matchSubject(payload: Record<string, unknown>): string {
  const tool = payload.tool_name ?? payload.tool;
  const subject = tool ?? payload.prompt ?? payload.event ?? "";
  const value = String(subject ?? "");
  return tool !== undefined ? canonicalToolName(value) : value;
}

function canonicalHookMatcher(matcher: string): string {
  return matcher === "Bash" ? "Shell" : matcher;
}

/** Parse a hook model response into `{ ok, reason }`, mirroring Python. */
function parseHookJson(text: string): { ok: boolean; reason?: string } {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as Record<string, unknown>).ok === "boolean"
    ) {
      const obj = parsed as { ok: boolean; reason?: string };
      return { ok: obj.ok, reason: obj.reason };
    }
  } catch {
    // fall through to heuristics
  }
  const lowered = text.trim().toLowerCase();
  if (lowered === "ok" || lowered === "true" || lowered === "yes") {
    return { ok: true };
  }
  return { ok: false, reason: text.trim() || "hook returned invalid JSON" };
}

export class HookExecutor implements IHookExecutor {
  private hooks = new Map<string, HookDefinition>();
  private client?: StreamingMessageClient;
  private defaultModel?: string;
  private cwd: string;
  private sessionId?: string;
  private settings?: Settings;
  private processExecutor?: EnvironmentProcessExecutor;

  constructor(options?: HookExecutorOptions) {
    this.client = options?.client;
    this.defaultModel = options?.defaultModel;
    this.cwd = options?.cwd ?? process.cwd();
    this.sessionId = options?.sessionId;
    this.settings = options?.settings;
    this.processExecutor = options?.processExecutor;
  }

  /** Inject (or replace) the model client used for prompt/agent hooks. */
  setClient(client: StreamingMessageClient | undefined, defaultModel?: string): void {
    this.client = client;
    if (defaultModel !== undefined) {
      this.defaultModel = defaultModel;
    }
  }

  register(hook: HookDefinition): void {
    this.hooks.set(hook.id, hook);
  }

  unregister(hookId: string): void {
    this.hooks.delete(hookId);
  }

  async execute(
    event: HookEvent,
    context: Record<string, unknown>
  ): Promise<HookResult> {
    const matching = this.getHooksForEvent(event, context);

    for (const hook of matching) {
      const result = await this.executeSingle(hook, event, context);
      if (result.blocked) {
        return result;
      }
    }

    return { blocked: false };
  }

  async executeWithResults(
    event: HookEvent,
    context: Record<string, unknown>
  ): Promise<DetailedHookResult[]> {
    const matching = this.getHooksForEvent(event, context);
    const results: DetailedHookResult[] = [];

    for (const hook of matching) {
      const start = performance.now();
      const hookResult = await this.executeSingle(hook, event, context);
      const durationMs = performance.now() - start;
      results.push({
        hookId: hook.id,
        success: !hookResult.blocked,
        durationMs,
        error: hookResult.blocked
          ? new Error(hookResult.reason ?? "blocked")
          : undefined,
      });
    }

    return results;
  }

  /**
   * Return hooks registered for an event, filtered by `enabled` and (optionally)
   * by a `matcher` against the payload subject, sorted by descending priority.
   * The sort is stable, so equal-priority hooks keep registration order.
   */
  getHooksForEvent(
    event: HookEvent,
    context?: Record<string, unknown>
  ): HookDefinition[] {
    const subject = context ? matchSubject(context) : "";
    const filtered = [...this.hooks.values()].filter((h) => {
      if (h.event !== event || !h.enabled) return false;
      if (h.matcher && context) return fnmatch(subject, canonicalHookMatcher(h.matcher));
      return true;
    });
    // Stable sort by descending priority (default 0).
    return filtered
      .map((hook, index) => ({ hook, index }))
      .sort((a, b) => {
        const pa = a.hook.priority ?? 0;
        const pb = b.hook.priority ?? 0;
        if (pb !== pa) return pb - pa;
        return a.index - b.index;
      })
      .map((entry) => entry.hook);
  }

  getAll(): readonly HookDefinition[] {
    return [...this.hooks.values()];
  }

  private async executeSingle(
    hook: HookDefinition,
    event: HookEvent,
    context: Record<string, unknown>
  ): Promise<HookResult> {
    const timeout = hook.timeout ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      switch (hook.type) {
        case "command":
          return await this.executeCommand(
            hook.command,
            controller.signal,
            event,
            context,
            hook.blockOnFailure ?? false
          );
        case "http":
          return await this.executeHttp(
            hook.url,
            hook.method ?? "POST",
            { event, payload: context },
            controller.signal
          );
        case "prompt":
          return await this.executePromptLike(hook, context, false);
        case "agent":
          return await this.executePromptLike(hook, context, true);
      }
    } catch {
      return { blocked: false };
    } finally {
      clearTimeout(timer);
    }
  }

  async executeCommand(
    command: string,
    signal: AbortSignal,
    event?: HookEvent,
    payload?: Record<string, unknown>,
    blockOnFailure = false
  ): Promise<HookResult> {
    const resolved = payload ? injectArguments(command, payload, true) : command;
    const env: Record<string, string> = {};
    if (event) env.VYKOR_HOOK_EVENT = event;
    if (payload) env.VYKOR_HOOK_PAYLOAD = JSON.stringify(payload);

    if (this.processExecutor) {
      try {
        const proc = await this.processExecutor.execShell(resolved, {
          cwd: this.cwd,
          env,
          signal,
        });
        let output = "";
        const stop = proc.onOutput((chunk) => { output += new TextDecoder().decode(chunk); });
        const stopErrors = proc.onErrorOutput?.((chunk) => { output += new TextDecoder().decode(chunk); });
        proc.end();
        const result = await proc.wait();
        stop();
        stopErrors?.();
        const success = result.exitCode === 0;
        return {
          blocked: blockOnFailure && !success,
          ...(!success ? { reason: output.trim() || `command hook failed with exit code ${result.exitCode ?? 1}` } : {}),
        };
      } catch (error) {
        return { blocked: blockOnFailure, reason: error instanceof Error ? error.message : String(error) };
      }
    }

    let proc: Awaited<ReturnType<typeof createShellProcess>>;
    try {
      proc = await createShellProcess(resolved, {
        cwd: this.cwd,
        sessionId: this.sessionId,
        settings: this.settings,
        env,
        signal,
        hostShell: "system",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { blocked: blockOnFailure, reason };
    }

    return new Promise<HookResult>((resolve) => {
      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        // Mirror Python's executor: success = (returncode === 0);
        // blocked = blockOnFailure && !success. No exit-code-2 special case
        // (that is a Claude Code convention, not an vykor one).
        const success = code === 0;
        if (success || !blockOnFailure) {
          resolve({ blocked: false });
        } else {
          const reason =
            stdout.trim() ||
            stderr.trim() ||
            `command hook failed with exit code ${code}`;
          resolve({ blocked: true, reason });
        }
      });

      proc.on("error", (err) => {
        resolve({ blocked: blockOnFailure, reason: err.message });
      });
    });
  }

  async executeHttp(
    url: string,
    method: string,
    body: unknown,
    signal: AbortSignal
  ): Promise<HookResult> {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      return {
        blocked: false,
        reason: `Hook HTTP request failed: ${response.status}`,
      };
    }

    try {
      const json = (await response.json()) as Record<string, unknown>;
      if (json.blocked === true) {
        return {
          blocked: true,
          reason: (json.reason as string) ?? "blocked by HTTP hook",
        };
      }
    } catch {
      // non-JSON success body; treat as not blocked
    }

    return { blocked: false };
  }

  /**
   * Evaluate a prompt/agent hook via the injected model client. When no client
   * is configured this is a non-blocking no-op (mirrors the optional-client
   * contract: never break callers that lack a client).
   */
  private async executePromptLike(
    hook: HookDefinition & { type: "prompt" | "agent" },
    context: Record<string, unknown>,
    agentMode: boolean
  ): Promise<HookResult> {
    if (!this.client) {
      return { blocked: false };
    }

    const prompt = injectArguments(hook.prompt, context);
    let system =
      "You are validating whether a hook condition passes in Vykor. " +
      'Return strict JSON: {"ok": true} or {"ok": false, "reason": "..."}.';
    if (agentMode) {
      system += " Be more thorough and reason over the payload before deciding.";
    }

    const params: StreamMessageParams = {
      model: hook.model ?? this.defaultModel ?? "",
      messages: [{ type: "user", content: prompt }],
      system,
      maxTokens: 512,
    };

    let text = "";
    for await (const ev of this.client.streamMessage(params)) {
      if (ev.type === "text_delta") {
        text += ev.delta;
      }
    }

    const parsed = parseHookJson(text);
    if (parsed.ok) {
      return { blocked: false };
    }
    // prompt/agent hooks block on rejection by default (Python: block_on_failure=True).
    const block = hook.blockOnFailure ?? true;
    return {
      blocked: block,
      reason: parsed.reason ?? "hook rejected the event",
    };
  }
}

export class HookLoader {
  private executor: HookExecutor;
  private watchers: Array<{ close: () => void }> = [];

  constructor(executor?: HookExecutor) {
    this.executor = executor ?? new HookExecutor();
  }

  async loadFromConfig(hooks: HookDefinition[]): Promise<number> {
    let count = 0;
    for (const hook of hooks) {
      this.executor.register(hook);
      count++;
    }
    return count;
  }

  async loadFromDirectory(
    dir: string,
    _pattern = "*.hook.{js,ts}"
  ): Promise<number> {
    const { readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    let count = 0;
    try {
      const entries = await readdir(dir);
      for (const file of entries) {
        if (!file.endsWith(".hook.js") && !file.endsWith(".hook.ts")) continue;
        try {
          const mod = await import(join(dir, file));
          const hooks: HookDefinition[] = mod?.hooks ?? mod?.default?.hooks ?? [];
          for (const hook of hooks) {
            this.executor.register(hook);
            count++;
          }
        } catch {
          // skip modules that fail to import
        }
      }
    } catch {
      // directory missing; nothing to load
    }
    return count;
  }

  watch(directory: string, intervalMs = 5000): void {
    const timer = setInterval(() => {
      this.loadFromDirectory(directory).catch(() => { });
    }, intervalMs);
    this.watchers.push({ close: () => clearInterval(timer) });
  }

  stopWatching(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  getExecutor(): HookExecutor {
    return this.executor;
  }
}

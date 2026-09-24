import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookExecutor } from "../src/index.js";
import type {
  HookDefinition,
  StreamEvent,
  StreamMessageParams,
  StreamingMessageClient,
} from "@vykor/core";

/**
 * POSIX-only: shellQuote produces POSIX single-quote escaping, which is only
 * honored when {shell:true} resolves to /bin/sh. On win32, spawn uses cmd.exe,
 * where this escaping does not apply, so these injection guarantees are tested
 * where they are meaningful.
 */
const itPosix = it.skipIf(process.platform === "win32");

let previousConfigDir: string | undefined;
let isolatedConfigDir: string;

beforeAll(() => {
  previousConfigDir = process.env.VYKOR_CONFIG_DIR;
  isolatedConfigDir = mkdtempSync(join(tmpdir(), "oh-hooks-config-"));
  process.env.VYKOR_CONFIG_DIR = isolatedConfigDir;
});

afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.VYKOR_CONFIG_DIR;
  else process.env.VYKOR_CONFIG_DIR = previousConfigDir;
  rmSync(isolatedConfigDir, { recursive: true, force: true });
});

/** A client that streams a fixed text response, capturing the last params. */
function fakeClient(responseText: string): {
  client: StreamingMessageClient;
  lastParams: () => StreamMessageParams | undefined;
} {
  let captured: StreamMessageParams | undefined;
  const client: StreamingMessageClient = {
    async *streamMessage(params: StreamMessageParams): AsyncIterable<StreamEvent> {
      captured = params;
      yield { type: "text_delta", delta: responseText } as StreamEvent;
      yield { type: "complete", stopReason: "end_turn" } as StreamEvent;
    },
  };
  return { client, lastParams: () => captured };
}

describe("HookExecutor", () => {
  it("fails closed for a blocking command hook when strict SRT is unavailable", async () => {
    const executor = new HookExecutor({
      cwd: process.cwd(),
      sessionId: "strict-hook",
      settings: {
        model: "test",
        apiFormat: "openai",
        maxTurns: 1,
        permission: { mode: "default" },
        sandbox: { enabled: true, failIfUnavailable: true },
      },
    });
    const result = await executor.executeCommand(
      "echo must-not-run-on-host",
      new AbortController().signal,
      undefined,
      undefined,
      true,
    );
    expect(result).toEqual({
      blocked: true,
      reason: expect.any(String),
    });
  });

  it("registers and retrieves hooks", () => {
    const executor = new HookExecutor();
    const hook: HookDefinition = {
      id: "h1",
      event: "pre_tool_use",
      type: "command",
      command: "echo hello",
      enabled: true,
    };
    executor.register(hook);
    expect(executor.getHooksForEvent("pre_tool_use")).toHaveLength(1);
  });

  it("unregister removes hook", () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "pre_tool_use",
      type: "command",
      command: "echo hello",
      enabled: true,
    });
    executor.unregister("h1");
    expect(executor.getHooksForEvent("pre_tool_use")).toHaveLength(0);
  });

  it("getHooksForEvent filters by event and enabled", () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "pre_tool_use",
      type: "command",
      command: "echo a",
      enabled: true,
    });
    executor.register({
      id: "h2",
      event: "post_tool_use",
      type: "command",
      command: "echo b",
      enabled: true,
    });
    executor.register({
      id: "h3",
      event: "pre_tool_use",
      type: "command",
      command: "echo c",
      enabled: false,
    });
    expect(executor.getHooksForEvent("pre_tool_use")).toHaveLength(1);
    expect(executor.getHooksForEvent("post_tool_use")).toHaveLength(1);
  });

  it("execute runs command hooks", async () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "session_start",
      type: "command",
      command: "echo test",
      enabled: true,
    });
    await executor.execute("session_start", {});
  });

  it("execute swallows errors", async () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "session_start",
      type: "command",
      command: "exit 1",
      enabled: true,
    });
    await expect(executor.execute("session_start", {})).resolves.toEqual({ blocked: false });
  });

  it("executeWithResults returns results", async () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "session_start",
      type: "command",
      command: "echo ok",
      enabled: true,
    });
    const results = await executor.executeWithResults("session_start", {});
    expect(results).toHaveLength(1);
    expect(results[0].hookId).toBe("h1");
    expect(results[0].success).toBe(true);
    expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("executeWithResults captures failures", async () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "session_start",
      type: "command",
      command: "exit 2",
      enabled: true,
      blockOnFailure: true,
    });
    const results = await executor.executeWithResults("session_start", {});
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBeDefined();
  });

  it("getAll returns all hooks", () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "pre_tool_use",
      type: "command",
      command: "echo a",
      enabled: true,
    });
    executor.register({
      id: "h2",
      event: "post_tool_use",
      type: "command",
      command: "echo b",
      enabled: true,
    });
    expect(executor.getAll()).toHaveLength(2);
  });

  it("executeCommand succeeds for valid command", async () => {
    const executor = new HookExecutor();
    const controller = new AbortController();
    await expect(
      executor.executeCommand("echo hello", controller.signal)
    ).resolves.toEqual({ blocked: false });
  });

  it("executeCommand does NOT special-case exit code 2 (aligns with Python)", async () => {
    // Python's executor has no exit-2 convention: success = (returncode == 0),
    // blocked = block_on_failure && !success. With blockOnFailure unset, exit 2
    // must NOT block.
    const executor = new HookExecutor();
    const controller = new AbortController();
    const result = await executor.executeCommand("exit 2", controller.signal);
    expect(result.blocked).toBe(false);
  });

  it("executeCommand blocks on exit code 2 only when blockOnFailure is set", async () => {
    const executor = new HookExecutor();
    const controller = new AbortController();
    const result = await executor.executeCommand(
      "exit 2",
      controller.signal,
      "pre_tool_use",
      {},
      true
    );
    expect(result.blocked).toBe(true);
  });

  it("executeCommand returns not blocked for non-zero exit", async () => {
    const executor = new HookExecutor();
    const controller = new AbortController();
    const result = await executor.executeCommand("exit 42", controller.signal);
    expect(result.blocked).toBe(false);
  });

  it("execute does NOT block on exit 2 without blockOnFailure", async () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "pre_tool_use",
      type: "command",
      command: "echo blocked && exit 2",
      enabled: true,
    });
    const result = await executor.execute("pre_tool_use", { tool: "bash" });
    expect(result.blocked).toBe(false);
  });

  it("execute returns blocked with reason from stdout when blockOnFailure is set", async () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "pre_tool_use",
      type: "command",
      command: "echo 'dangerous operation detected' && exit 2",
      enabled: true,
      blockOnFailure: true,
    });
    const result = await executor.execute("pre_tool_use", { tool: "bash" });
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("dangerous");
  });
});

describe("HookExecutor — priority ordering", () => {
  it("orders by descending priority within an event", () => {
    const executor = new HookExecutor();
    executor.register({
      id: "low",
      event: "pre_tool_use",
      type: "command",
      command: "echo low",
      enabled: true,
      priority: 1,
    });
    executor.register({
      id: "high",
      event: "pre_tool_use",
      type: "command",
      command: "echo high",
      enabled: true,
      priority: 10,
    });
    executor.register({
      id: "mid",
      event: "pre_tool_use",
      type: "command",
      command: "echo mid",
      enabled: true,
      priority: 5,
    });
    const ids = executor.getHooksForEvent("pre_tool_use").map((h) => h.id);
    expect(ids).toEqual(["high", "mid", "low"]);
  });

  it("keeps registration order for equal priority (stable sort)", () => {
    const executor = new HookExecutor();
    for (const id of ["a", "b", "c", "d"]) {
      executor.register({
        id,
        event: "pre_tool_use",
        type: "command",
        command: `echo ${id}`,
        enabled: true,
        // no priority -> default 0
      });
    }
    const ids = executor.getHooksForEvent("pre_tool_use").map((h) => h.id);
    expect(ids).toEqual(["a", "b", "c", "d"]);
  });

  it("default priority (0) sorts below positive priorities", () => {
    const executor = new HookExecutor();
    executor.register({
      id: "default",
      event: "stop",
      type: "command",
      command: "echo d",
      enabled: true,
    });
    executor.register({
      id: "boosted",
      event: "stop",
      type: "command",
      command: "echo b",
      enabled: true,
      priority: 3,
    });
    const ids = executor.getHooksForEvent("stop").map((h) => h.id);
    expect(ids).toEqual(["boosted", "default"]);
  });

  it("executes hooks in priority order until one blocks", async () => {
    const executor = new HookExecutor();
    const order: string[] = [];
    const spy = vi
      .spyOn(executor, "executeCommand")
      .mockImplementation(async (command) => {
        order.push(command);
        // The high-priority one blocks; low-priority should never run.
        if (command.includes("block")) return { blocked: true, reason: "stop" };
        return { blocked: false };
      });
    executor.register({
      id: "low",
      event: "pre_tool_use",
      type: "command",
      command: "echo low",
      enabled: true,
      priority: 0,
    });
    executor.register({
      id: "high",
      event: "pre_tool_use",
      type: "command",
      command: "echo block",
      enabled: true,
      priority: 10,
    });
    const result = await executor.execute("pre_tool_use", {});
    expect(result.blocked).toBe(true);
    expect(order).toEqual(["echo block"]);
    spy.mockRestore();
  });
});

describe("HookExecutor — matcher filtering", () => {
  it("includes hooks whose matcher matches the tool name", () => {
    const executor = new HookExecutor();
    executor.register({
      id: "bash-only",
      event: "pre_tool_use",
      type: "command",
      command: "echo x",
      enabled: true,
      matcher: "Bash",
    });
    const matched = executor.getHooksForEvent("pre_tool_use", {
      tool_name: "Shell",
    });
    expect(matched).toHaveLength(1);
  });

  it("excludes hooks whose matcher does not match", () => {
    const executor = new HookExecutor();
    executor.register({
      id: "bash-only",
      event: "pre_tool_use",
      type: "command",
      command: "echo x",
      enabled: true,
      matcher: "Bash",
    });
    const matched = executor.getHooksForEvent("pre_tool_use", {
      tool_name: "Read",
    });
    expect(matched).toHaveLength(0);
  });

  it("supports glob-style matchers", () => {
    const executor = new HookExecutor();
    executor.register({
      id: "glob",
      event: "pre_tool_use",
      type: "command",
      command: "echo x",
      enabled: true,
      matcher: "mcp__*",
    });
    expect(
      executor.getHooksForEvent("pre_tool_use", { tool_name: "mcp__github" })
    ).toHaveLength(1);
    expect(
      executor.getHooksForEvent("pre_tool_use", { tool_name: "Bash" })
    ).toHaveLength(0);
  });

  it("matches against the `tool` payload key as well", () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h",
      event: "pre_tool_use",
      type: "command",
      command: "echo x",
      enabled: true,
      matcher: "Bash",
    });
    expect(
      executor.getHooksForEvent("pre_tool_use", { tool: "Bash" })
    ).toHaveLength(1);
  });

  it("no matcher always matches", () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h",
      event: "pre_tool_use",
      type: "command",
      command: "echo x",
      enabled: true,
    });
    expect(
      executor.getHooksForEvent("pre_tool_use", { tool_name: "anything" })
    ).toHaveLength(1);
  });
});

describe("HookExecutor — $ARGUMENTS injection + shell escaping", () => {
  it("injects the JSON payload into $ARGUMENTS", async () => {
    const executor = new HookExecutor();
    let received = "";
    const spy = vi
      .spyOn(executor, "executeCommand")
      .mockImplementation(async (command) => {
        received = command;
        return { blocked: false };
      });
    executor.register({
      id: "h",
      event: "pre_tool_use",
      type: "command",
      command: "validate.sh $ARGUMENTS",
      enabled: true,
    });
    // executeCommand is mocked, so verify the raw command still contains the
    // placeholder; injection happens inside executeCommand itself. Drive the
    // real path instead via direct call below.
    await executor.execute("pre_tool_use", { tool: "bash" });
    expect(received).toBe("validate.sh $ARGUMENTS");
    spy.mockRestore();
  });

  itPosix(
    "delivers the escaped payload to the child as one intact argv element",
    async () => {
      const executor = new HookExecutor();
      const controller = new AbortController();
      const dir = mkdtempSync(join(tmpdir(), "oh-hook-"));
      const sentinel = join(dir, "argv.txt");
      const sentinelPosix = sentinel.replace(/\\/g, "/");
      try {
        // Payload has a single quote and spaces; with correct shlex-style
        // escaping the child must receive the *exact* serialized JSON as a
        // single argv element. The child writes argv[1] to a sentinel file.
        const payload = { msg: "it's a test", n: 5 };
        const expected = JSON.stringify(payload);
        const script = `require('fs').writeFileSync(process.argv[1], process.argv[2])`;
        const result = await executor.executeCommand(
          `node -e ${JSON.stringify(script)} -- ${JSON.stringify(
            sentinelPosix
          )} $ARGUMENTS`,
          controller.signal,
          "pre_tool_use",
          payload
        );
        expect(result.blocked).toBe(false);
        // The captured argv must equal the serialized JSON byte-for-byte: not
        // split on the space, not truncated at the quote.
        expect(readFileSync(sentinel, "utf8")).toBe(expected);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  itPosix(
    "does not execute injected commands hidden in the payload",
    async () => {
      const executor = new HookExecutor();
      const controller = new AbortController();
      const dir = mkdtempSync(join(tmpdir(), "oh-hook-"));
      // Use forward-slash paths in the shell text so the payload is path-free of
      // backslashes (keeps the literal-equality assertion portable).
      const sentinel = join(dir, "received.txt");
      const sentinelPosix = sentinel.replace(/\\/g, "/");
      // Marker the attacker would create IF command substitution / chaining ran.
      const pwned = join(dir, "PWNED");
      const pwnedPosix = pwned.replace(/\\/g, "/");
      try {
        // A payload packed with shell metacharacters: command substitution
        // ($() and backticks), command chaining (; touch), and quotes. If any of
        // these were evaluated by the shell, the PWNED marker would be created.
        const evil =
          `$(touch '${pwnedPosix}')` +
          " `touch '" +
          pwnedPosix +
          "'` ; touch '" +
          pwnedPosix +
          "' && touch '" +
          pwnedPosix +
          "' '\"injected\"'";
        const payload = { evil };
        const expected = JSON.stringify(payload);
        // The child writes the literal arg it received; if escaping worked, the
        // file holds the literal JSON (with $(...)/backticks unevaluated) and the
        // PWNED marker is never created.
        const script = `require('fs').writeFileSync(process.argv[1], process.argv[2])`;
        const result = await executor.executeCommand(
          `node -e ${JSON.stringify(script)} -- ${JSON.stringify(
            sentinelPosix
          )} $ARGUMENTS`,
          controller.signal,
          "pre_tool_use",
          payload
        );
        expect(result.blocked).toBe(false);
        // Proof of non-execution: the injected commands left no marker file...
        expect(existsSync(pwned)).toBe(false);
        // ...and the child received the malicious payload as a literal string,
        // i.e. $(...) and backticks are still present, unevaluated.
        const received = readFileSync(sentinel, "utf8");
        expect(received).toBe(expected);
        expect(received).toContain("$(touch");
        expect(received).toContain("`touch");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  it("injects VYKOR_HOOK_EVENT and VYKOR_HOOK_PAYLOAD env vars", async () => {
    const executor = new HookExecutor();
    const controller = new AbortController();
    // A non-zero exit gated on the env var, combined with blockOnFailure, proves
    // env injection reached the shell (only blocks if the var matched).
    const result = await executor.executeCommand(
      process.platform === "win32"
        ? 'if "%VYKOR_HOOK_EVENT%"=="pre_tool_use" (exit 1)'
        : 'test "$VYKOR_HOOK_EVENT" = "pre_tool_use" && exit 1',
      controller.signal,
      "pre_tool_use",
      {},
      true
    );
    expect(result.blocked).toBe(true);
  });
});

describe("HookExecutor — new event types dispatch", () => {
  const events = [
    "pre_compact",
    "post_compact",
    "user_prompt_submit",
    "notification",
    "stop",
    "subagent_stop",
  ] as const;

  for (const event of events) {
    it(`registers and dispatches ${event}`, async () => {
      const executor = new HookExecutor();
      let ran = false;
      const spy = vi
        .spyOn(executor, "executeCommand")
        .mockImplementation(async () => {
          ran = true;
          return { blocked: false };
        });
      executor.register({
        id: `h-${event}`,
        event,
        type: "command",
        command: "echo hi",
        enabled: true,
      });
      const result = await executor.execute(event, {});
      expect(ran).toBe(true);
      expect(result.blocked).toBe(false);
      spy.mockRestore();
    });
  }
});

describe("HookExecutor — prompt/agent hooks", () => {
  it("prompt hook is a non-blocking no-op without a client", async () => {
    const executor = new HookExecutor();
    executor.register({
      id: "p",
      event: "pre_tool_use",
      type: "prompt",
      prompt: "Is $ARGUMENTS safe?",
      enabled: true,
    });
    const result = await executor.execute("pre_tool_use", { tool: "bash" });
    expect(result).toEqual({ blocked: false });
  });

  it("agent hook is a non-blocking no-op without a client", async () => {
    const executor = new HookExecutor();
    executor.register({
      id: "a",
      event: "pre_tool_use",
      type: "agent",
      prompt: "Inspect $ARGUMENTS",
      enabled: true,
    });
    const result = await executor.execute("pre_tool_use", {});
    expect(result).toEqual({ blocked: false });
  });

  it("prompt hook passes when client returns ok:true", async () => {
    const { client } = fakeClient('{"ok": true}');
    const executor = new HookExecutor({ client, defaultModel: "test-model" });
    executor.register({
      id: "p",
      event: "pre_tool_use",
      type: "prompt",
      prompt: "Is $ARGUMENTS safe?",
      enabled: true,
    });
    const result = await executor.execute("pre_tool_use", { tool: "bash" });
    expect(result.blocked).toBe(false);
  });

  it("prompt hook blocks when client returns ok:false", async () => {
    const { client } = fakeClient('{"ok": false, "reason": "too risky"}');
    const executor = new HookExecutor({ client, defaultModel: "test-model" });
    executor.register({
      id: "p",
      event: "pre_tool_use",
      type: "prompt",
      prompt: "Is $ARGUMENTS safe?",
      enabled: true,
    });
    const result = await executor.execute("pre_tool_use", { tool: "rm" });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("too risky");
  });

  it("injects $ARGUMENTS and model into the prompt request", async () => {
    const { client, lastParams } = fakeClient('{"ok": true}');
    const executor = new HookExecutor({ client, defaultModel: "default-model" });
    executor.register({
      id: "p",
      event: "pre_tool_use",
      type: "prompt",
      prompt: "Check $ARGUMENTS",
      model: "explicit-model",
      enabled: true,
    });
    await executor.execute("pre_tool_use", { tool: "bash" });
    const params = lastParams();
    expect(params?.model).toBe("explicit-model");
    const userMsg = params?.messages[0];
    expect(userMsg?.type).toBe("user");
    expect(String(userMsg?.content)).toContain('"tool":"bash"');
  });

  it("setClient enables prompt evaluation after construction", async () => {
    const executor = new HookExecutor();
    const { client } = fakeClient('{"ok": false, "reason": "nope"}');
    executor.setClient(client, "m");
    executor.register({
      id: "p",
      event: "pre_tool_use",
      type: "prompt",
      prompt: "Check $ARGUMENTS",
      enabled: true,
    });
    const result = await executor.execute("pre_tool_use", {});
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("nope");
  });
});

describe("HookExecutor — blockOnFailure for command hooks", () => {
  it("blocks on non-zero (non-2) exit when blockOnFailure is set", async () => {
    const executor = new HookExecutor();
    const controller = new AbortController();
    const result = await executor.executeCommand(
      "exit 1",
      controller.signal,
      "pre_tool_use",
      {},
      true
    );
    expect(result.blocked).toBe(true);
  });

  it("does not block on non-zero exit when blockOnFailure is unset", async () => {
    const executor = new HookExecutor();
    const controller = new AbortController();
    const result = await executor.executeCommand(
      "exit 1",
      controller.signal,
      "pre_tool_use",
      {},
      false
    );
    expect(result.blocked).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { QueryEngine } from "./query-engine.js";
import { ToolRegistry } from "./tool-registry.js";

/**
 * 回归测试：工具失败记录只能被「新证据」解锁，不能被恢复守卫自己刷新。
 *
 * 场景（用户报告）：多步骤任务里工具先失败几次，之后模型找到可行办法且
 * 该工具成功返回（新证据），但之前失败的同参数调用仍被判定为「不许重试」，
 * 反复被拒后耗尽恢复预算，引擎强制结束并要求模型「说明阻塞点」，
 * 剩下的工作没有完成。
 */

function allowAll(): any {
  return { checkTool: async () => ({ action: "allow", reason: "test" }) };
}

const noopHooks: any = { execute: async () => ({ blocked: false }) };

const FORCED_FINAL_MARKER = "Stop using tools";

/** Build succeeds only after the dependency has been installed. */
function createBuildRegistry() {
  const state = { attempts: [] as string[], installed: false, steps: [] as number[] };
  const registry = new ToolRegistry();
  registry.register({
    name: "Build",
    description: "run the build",
    inputSchema: { type: "object", properties: { target: { type: "string" } } },
    execute: async () => {
      state.attempts.push("build");
      const ok = state.installed;
      return {
        content: [{ type: "text" as const, text: ok ? "Build succeeded" : "missing dependency" }],
        isError: !ok,
      };
    },
  });
  registry.register({
    name: "Install",
    description: "install the missing dependency",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      state.installed = true;
      return { content: [{ type: "text" as const, text: "dependency installed" }] };
    },
  });
  registry.register({
    name: "Work",
    description: "remaining work",
    inputSchema: { type: "object", properties: { step: { type: "number" } } },
    execute: async (input) => {
      state.steps.push(input.step as number);
      return { content: [{ type: "text" as const, text: "step done" }] };
    },
  });
  return { registry, state };
}

/**
 * 逐轮脚本化的假客户端：按顺序执行 turns，脚本用完后给出最终回答并结束本轮任务。
 * 收到没有 tools 的请求（引擎强制收尾）时，模拟模型「报告阻塞、无法继续」。
 */
const BLOCKER_TEXT = "I cannot continue: the build keeps being rejected.";

function scriptedClient(
  turns: Array<Array<{ name: string; input: Record<string, unknown> }>>,
  finalText = "All requested work finished.",
) {
  const requests: any[] = [];
  let turn = 0;
  const client = {
    streamMessage: async function* (params: any) {
      requests.push(params);
      if (!params.tools) {
        yield { type: "text_delta" as const, delta: BLOCKER_TEXT };
        yield { type: "complete" as const, stopReason: "end_turn" };
        return;
      }
      if (turn >= turns.length) {
        yield { type: "text_delta" as const, delta: finalText };
        yield { type: "complete" as const, stopReason: "end_turn" };
        return;
      }
      const calls = turns[turn++]!;
      for (let i = 0; i < calls.length; i++) {
        yield {
          type: "tool_use_start" as const,
          toolUse: {
            type: "tool_use" as const,
            id: `tu-${turn}-${i}`,
            name: calls[i]!.name,
            input: calls[i]!.input,
          },
        };
      }
      yield { type: "complete" as const, stopReason: "tool_use" };
    },
  };
  return { requests, client };
}

describe("Tool failure evidence unlocks retries", () => {
  it.each([true, false])(
    "retries an identical failed call once new evidence arrived in the same batch (success first: %s)",
    async (successFirst) => {
      const { registry, state } = createBuildRegistry();
      const guard = { name: "Build", input: { target: "app" } };
      const install = { name: "Install", input: {} };
      const { client } = scriptedClient([
        [guard], // fails: missing dependency
        successFirst ? [install, guard] : [guard, install], // dependency installed, retry rejected
        [guard], // now viable: must actually run
      ]);

      const engine = new QueryEngine(client, registry, allowAll(), noopHooks, { maxTurns: 20 });
      const events: any[] = [];
      for await (const event of engine.submitMessage("install the dependency then build")) {
        events.push(event);
      }

      expect(state.attempts).toEqual(["build", "build"]);
      const lastResult = events.filter((e) => e.type === "tool_use_end").at(-1);
      expect(lastResult?.result.isError).toBe(false);
      expect(lastResult?.result.content[0].text).toBe("Build succeeded");
    },
  );

  it("still blocks an unchanged retry while the evidence is unchanged", async () => {
    const { registry, state } = createBuildRegistry();
    const guard = { name: "Build", input: { target: "app" } };
    const { client } = scriptedClient([[guard], [guard]]);

    const engine = new QueryEngine(client, registry, allowAll(), noopHooks, { maxTurns: 20 });
    const events: any[] = [];
    for await (const event of engine.submitMessage("build the app")) events.push(event);

    expect(state.attempts).toEqual(["build"]);
    const toolEnds = events.filter((e) => e.type === "tool_use_end") as any[];
    expect(toolEnds).toHaveLength(2);
    expect(toolEnds[1].result.isError).toBe(true);
    expect(toolEnds[1].result.content[0].text).toContain("already failed with the same input");
  });

  it("does not execute a permission-denied call again", async () => {
    const registry = new ToolRegistry();
    let executions = 0;
    registry.register({
      name: "Write",
      description: "write a file",
      inputSchema: { type: "object", properties: { file_path: { type: "string" } } },
      execute: async () => {
        executions++;
        return { content: [{ type: "text" as const, text: "written" }] };
      },
    });
    let checks = 0;
    const denyAll: any = {
      checkTool: async () => {
        checks++;
        return { action: "deny", reason: "not allowed" };
      },
    };
    const call = { name: "Write", input: { file_path: "/work/a.txt" } };
    const { client } = scriptedClient([[call], [call]]);

    const engine = new QueryEngine(client, registry, denyAll, noopHooks, { maxTurns: 20 });
    const events: any[] = [];
    for await (const event of engine.submitMessage("write a file")) events.push(event);

    expect(checks).toBe(1);
    expect(executions).toBe(0);
    const toolEnds = events.filter((e) => e.type === "tool_use_end") as any[];
    expect(toolEnds[0].result.failureKind).toBe("permission");
    expect(toolEnds[1].result.content[0].text).toContain("already failed with the same input");
  });

  it("finishes the remaining work instead of forcing a blocker report", async () => {
    const { registry, state } = createBuildRegistry();
    const requests: any[] = [];
    const responses: Array<Array<{ name: string; input: Record<string, unknown> }>> = [
      [{ name: "Build", input: { target: "app" } }],
      [{ name: "Install", input: {} }, { name: "Build", input: { target: "app" } }],
    ];
    let turn = 0;
    const adaptive = {
      streamMessage: async function* (params: any) {
        requests.push(params);
        if (!params.tools) {
          yield { type: "text_delta" as const, delta: "I cannot continue: the build keeps being rejected." };
          yield { type: "complete" as const, stopReason: "end_turn" };
          return;
        }
        const calls = turn < responses.length
          ? responses[turn++]!
          : state.attempts.length < 2
            ? [{ name: "Build", input: { target: "app" } }]
            : state.steps.length < 2
              ? [{ name: "Work", input: { step: state.steps.length + 1 } }]
              : [];
        if (calls.length === 0) {
          yield { type: "text_delta" as const, delta: "All work complete." };
          yield { type: "complete" as const, stopReason: "end_turn" };
          return;
        }
        for (let i = 0; i < calls.length; i++) {
          yield {
            type: "tool_use_start" as const,
            toolUse: { type: "tool_use" as const, id: `tu-${turn}-${i}`, name: calls[i]!.name, input: calls[i]!.input },
          };
        }
        yield { type: "complete" as const, stopReason: "tool_use" };
      },
    };

    const engine = new QueryEngine(adaptive, registry, allowAll(), noopHooks, { maxTurns: 30 });
    for await (const _ of engine.submitMessage("install the dependency then build the app")) {
      /* consume */
    }

    expect(state.attempts).toEqual(["build", "build"]);
    expect(state.steps).toEqual([1, 2]);
    expect(requests.filter((r) => !r.tools && String(r.system).includes(FORCED_FINAL_MARKER))).toHaveLength(0);
    expect(engine.getHistory().at(-1)?.content).toBe("All work complete.");
  });
});

import { createInterface } from "node:readline/promises";
import { stripVTControlCharacters } from "node:util";
import {
  VykorApiError,
  VykorClient,
  createPromptRequestId,
  selectSessionPermissions,
  syncEvents,
  waitForRun,
} from "@rzx/client";

const { VYKOR_BASE_URL, VYKOR_TOKEN, VYKOR_MODEL, VYKOR_DAEMON_CWD } = process.env;
if (!VYKOR_BASE_URL || !VYKOR_TOKEN || !VYKOR_MODEL || !VYKOR_DAEMON_CWD) {
  throw new Error("请提供 VYKOR_BASE_URL、VYKOR_TOKEN、VYKOR_MODEL 和 VYKOR_DAEMON_CWD");
}

const client = new VykorClient({
  baseUrl: VYKOR_BASE_URL,
  token: VYKOR_TOKEN,
  // 也给 SDK 共用的首次协议握手设置期限，不留下无期限的网络请求。
  fetch: (input, init) => fetch(input, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(10_000),
  }),
});
const controller = new AbortController();
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
const cancel = () => controller.abort(new Error("用户取消了本地等待"));
const terminal = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
terminal?.on("SIGINT", cancel);
process.once("SIGINT", cancel);

try {
  // cwd 属于 daemon 机器。新建专用会话，避免影响其他调用方的运行。
  const session = await client.sessions.create({
    cwd: VYKOR_DAEMON_CWD,
    model: VYKOR_MODEL,
    metadata: { runtime: { model: VYKOR_MODEL, approvalMode: "ask" } },
  }, { signal });
  console.log("新会话:", session.id);

  // 提交前就开始观察；首次快照也会补上流连接前产生的权限请求。
  // 本示例拒绝工具操作。AskUser 是业务提问，交给终端用户填写答案。
  const answeredPermissions = new Set<string>();
  const permissionTask = (async () => {
    for await (const update of syncEvents(client, { sessionId: session.id, signal })) {
      for (const request of selectSessionPermissions(update.state.buckets[session.id])) {
        if (request.status !== "pending" || answeredPermissions.has(request.id)) continue;
        // 回复事件可能晚于其他更新到达；发出请求前记住 ID，避免重复回复。
        answeredPermissions.add(request.id);
        try {
          const input = request.payload.input;
          if (terminal && request.toolName === "AskUser" && input && typeof input === "object" &&
              "kind" in input && input.kind === "question" && "question" in input && typeof input.question === "string") {
            const question = stripVTControlCharacters(input.question).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
            const answer = await terminal.question(`Agent 提问 · ${question} `, { signal });
            await client.permissions.reply(request.id, { status: "approved", decision: "once", answer }, { signal });
          } else {
            await client.permissions.reply(request.id, { status: "denied" }, { signal });
            console.log("已拒绝请求:", request.id);
          }
        } catch (error) {
          // 其他客户端可能抢先回复；409 不代表观察或后台运行失败。
          if (!(error instanceof VykorApiError && error.status === 409)) throw error;
          console.log("权限请求已由其他客户端处理:", request.id);
        }
      }
    }
  })().catch(error => {
    // 权限观察失败时也结束主等待，交给 finally 中断后台运行。
    if (!signal.aborted) controller.abort(error);
  });

  let admissionAttempted = false;
  let runId: string | undefined;
  let reachedTerminalState = false;
  try {
    console.log("即将提交真实 Agent 任务，会使用 daemon 已配置的模型并可能产生费用。");
    // 重试同一笔提交时保留这个 id 和内容；新任务才生成新 id。
    const promptId = createPromptRequestId();
    admissionAttempted = true;
    const admitted = await client.sessions.admitPrompt(session.id, {
      id: promptId,
      items: [{
        type: "text",
        text: terminal
          ? "请用 AskUser 的 question 字段询问我希望使用哪种语言，再用该语言写一句自我介绍。除此之外无需调用工具。"
          : "请用一句话介绍你的能力，不调用工具。",
      }],
    }, { signal });
    runId = admitted.run?.id;
    if (!runId) throw new Error("本次输入未创建 Run，请检查返回的 input 和 queue_state");

    const { run, messages } = await waitForRun(client, { sessionId: session.id, runId, signal });
    reachedTerminalState = true;
    console.log("Run 终态:", run.status);
    for (const { message, parts } of messages) {
      if (message.role !== "assistant") continue;
      console.log(parts.filter(part => part.type === "text").map(part => part.text ?? "").join(""));
    }
    // failed/interrupted 也属于终态；waitForRun 不把它们转换成异常。
    if (run.status !== "completed") process.exitCode = 1;
  } finally {
    try {
      if (admissionAttempted && !reachedTerminalState) {
        // AbortSignal 只取消本地等待；interrupt 才请求 daemon 停止后台任务。
        // 若提交响应丢失，专用新会话中断当前运行，避免遗留未知 runId 的任务。
        await client.sessions.interrupt(session.id, {
          expectedRunId: runId,
          signal: AbortSignal.timeout(10_000),
        });
      }
    } catch (error) {
      console.error(`未能确认中断，请在 daemon 中检查会话 ${session.id}:`, error);
      process.exitCode = 1;
    } finally {
      controller.abort();
      await permissionTask;
    }
  }
} finally {
  terminal?.close();
  process.removeListener("SIGINT", cancel);
}

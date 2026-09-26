import { test, expect } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { ThemeProvider } from "../../theme/ThemeContext";
import { Session } from "./Session";
import { Footer } from "./Footer";
import type { TranscriptItem, McpServerSnapshot } from "../../types";

// ─── Test 1: Session renders mixed transcript ──────────────────────────────

test("Session renders mixed transcript items", async () => {
  const items: TranscriptItem[] = [
    { role: "user", text: "Hello from user" },
    { role: "assistant", text: "Some assistant response text here" },
    {
      role: "tool",
      text: "",
      tool_name: "bash_tool",
      tool_input: { command: "echo hello" },
    },
    { role: "tool_result", text: "hello\nmore output" },
    { role: "system", text: "System log message" },
  ];

  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <Session
        items={items}
        assistantBuffer=""
      />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );

  await renderOnce();
  // markdown 解析是异步的：轮询渲染直到 assistant 内容出现
  for (let i = 0; i < 40; i++) {
    await renderOnce();
    await new Promise((r) => setTimeout(r, 20));
    if (captureCharFrame().includes("assistant response")) break;
  }
  const frame = captureCharFrame();

  // User text present
  expect(frame).toContain("Hello from user");

  // assistant markdown rendered (async parse, polled above)
  expect(frame).toContain("Some assistant response text here");

  // Tool name present
  expect(frame).toContain("bash_tool");

  // Tool input summary (command) present
  expect(frame).toContain("echo hello");

  // tool_result first line
  expect(frame).toContain("hello");

  // system text present
  expect(frame).toContain("System log message");

  renderer.destroy();
});

// ─── Test 2: assistantBuffer shows streaming content ─────────────────────

test("Session renders streaming assistantBuffer", async () => {
  const { renderer, renderOnce, waitForFrame, captureCharFrame } = await testRender(
    <ThemeProvider>
      <Session
        items={[]}
        assistantBuffer="Streaming content here"
      />
    </ThemeProvider>,
    { width: 100, height: 20 },
  );

  await renderOnce();
  await waitForFrame((f) => f.includes("Streaming content here"), { maxPasses: 30 });
  const frame = captureCharFrame();

  expect(frame).toContain("Streaming content here");

  renderer.destroy();
});

test("Session shows retry countdown and incomplete known usage using terminal text", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <Session
        items={[{ role: "user", text: "question" }]}
        assistantBuffer=""
        retry={{ generationId: "g1", attempt: 1, retryNumber: 2, maxRetries: 5, reason: "network", nextRetryAt: Date.now() + 2_000, recoveryDeadlineAt: Date.now() + 30_000 }}
        usage={{ incomplete: true, unknownAttempts: 1, partialAttempts: 0 }}
        inputTokens={20}
        outputTokens={10}
      />
    </ThemeProvider>,
    { width: 100, height: 20 },
  );
  await renderOnce();
  const frame = captureCharFrame();
  expect(frame).toContain("连接中断，2 秒后重试（第 2/5 次）");
  expect(frame).toContain("已知用量：20 输入 / 10 输出；部分请求用量未知");
  renderer.destroy();
});

test("Session keeps tool output collapsed by default and expands on click", async () => {
  const items: TranscriptItem[] = [
    { role: "tool_result", text: "hello\nmore output" },
  ];

  const { renderer, renderOnce, waitForFrame, captureCharFrame, mockMouse } = await testRender(
    <ThemeProvider>
      <Session
        items={items}
        assistantBuffer=""
      />
    </ThemeProvider>,
    { width: 100, height: 20 },
  );

  await renderOnce();
  await waitForFrame((f) => f.includes("output 2 lines"));

  let frame = captureCharFrame();
  expect(frame).toContain("hello");
  expect(frame).not.toContain("more output");

  await mockMouse.click(4, 1);
  await renderOnce();
  await waitForFrame((f) => f.includes("more output"));

  frame = captureCharFrame();
  expect(frame).toContain("more output");

  renderer.destroy();
});

// ─── Test 3: Footer renders plan mode, tokens, MCP count, version ────────

test("Footer renders plan indicator, MCP count, tokens, version", async () => {
  const status: Record<string, unknown> = {
    model: "claude-3-5-sonnet",
    permission_mode: "plan",
    session_mode: "coordinator",
    input_tokens: 12345,
    output_tokens: 678,
  };

  const mcpServers: McpServerSnapshot[] = [
    { name: "server-a", state: "connected" },
    { name: "server-b", state: "connected" },
  ];

  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <Footer status={status} mcpServers={mcpServers} version="1.2.3" />
    </ThemeProvider>,
    { width: 120, height: 5 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  // Plan mode indicator
  expect(frame).toContain("[PLAN]");
  expect(frame).toContain("[COORDINATOR]");

  // MCP servers count
  expect(frame).toContain("2 MCP");

  // Tokens: 12345 → "12.3k↓", 678 → "678↑"
  expect(frame).toContain("12.3k");
  expect(frame).toContain("678");

  // Version
  expect(frame).toContain("1.2.3");

  renderer.destroy();
});

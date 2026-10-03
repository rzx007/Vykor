import { expect, it } from "vitest";
import { captureNativeUiLogs, expectNoPrivateUiData } from "../../../../agent-runtime/test-helpers/native-ui-logs.js";

it.each([
  { name: "Windows installation path", secret: 'C:\\Users\\author\\config\\plugins\\private',
    logger: [{ details: { path: 'C:\\Users\\author\\config\\plugins\\private' } }] },
  { name: "quoted HTML with control characters", secret: '<p title="private">line\n\t正文</p>',
    logger: [{ details: { document: '<p title="private">line\n\t正文</p>' } }] },
  { name: "quoted action parameter with control characters", secret: 'private "choice"\n\tvalue',
    logger: [{ details: { args: { value: 'private "choice"\n\tvalue' } } }] },
])("detects injected $name in logger, Native audit and public response values", ({ secret, logger }) => {
  const captured = captureNativeUiLogs({ pluginId: "privacy.fixture", sessionId: "privacy-session",
    toolNames: ["Fixture"], inputSummaries: [secret] });
  try {
    process.stderr.write(`[native-tool:audit] ${JSON.stringify({ type: "native_tool_call", pluginId: "privacy.fixture",
      sessionId: "privacy-session", toolName: "Fixture", cwd: "D:/project", inputSummary: secret,
      status: "completed", durationMs: 0 })}\n`);
    expect(() => expectNoPrivateUiData(logger, [secret])).toThrow();
    expect(() => expectNoPrivateUiData(captured.values, [secret])).toThrow();
    expect(() => expectNoPrivateUiData({ instance: { data: { leak: secret } } }, [secret])).toThrow();
  } finally { captured.verify(); }
});

it("accepts public values without private fixture content", () => {
  expect(() => expectNoPrivateUiData([{ code: "plugin_ui_unavailable", details: { enabled: false } }],
    ['C:\\Users\\author\\config\\plugins\\private', '<p title="private">line\n\t正文</p>', 'private "choice"\n\tvalue'])).not.toThrow();
});

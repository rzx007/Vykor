import { expect, vi } from "vitest";

/** Capture only the fixture's declared logs; keep unexpected stderr visible and fail. */
export function captureNativeUiLogs(options: {
  pluginId: string;
  sessionId: string;
  toolNames: string[];
  inputSummaries: string[];
  diagnostics?: string[];
}) {
  const records: string[] = [];
  const unexpected: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk, ...args) => {
    const text = String(chunk);
    const audit = text.startsWith("[native-tool:audit] ");
    const diagnostic = options.diagnostics?.some(message => text === `[plugins] ${options.pluginId}: ${message}\n`);
    if (!audit && !diagnostic) {
      unexpected.push(text);
      return write(chunk, ...args);
    }
    records.push(text);
    const callback = args.find(value => typeof value === "function");
    if (typeof callback === "function") callback();
    return true;
  });
  return {
    records,
    verify() {
      spy.mockRestore();
      expect(unexpected, "Unexpected stderr remains visible above").toEqual([]);
      for (const text of records.filter(record => record.startsWith("[native-tool:audit] "))) {
        const record = JSON.parse(text.slice("[native-tool:audit] ".length));
        expect(Object.keys(record).sort()).toEqual([
          "cwd", "durationMs", ...(record.status === "failed" ? ["errorCode"] : []),
          "inputSummary", "pluginId", "sessionId", "status", "toolName", "type",
        ].sort());
        expect(record).toMatchObject({ type: "native_tool_call", pluginId: options.pluginId, sessionId: options.sessionId });
        expect(options.toolNames).toContain(record.toolName);
        expect(options.inputSummaries).toContain(record.inputSummary);
        expect(["completed", "failed"]).toContain(record.status);
        expect(record.durationMs).toBeGreaterThanOrEqual(0);
        expect(typeof record.cwd).toBe("string");
        if (record.status === "failed") expect(record.errorCode).toBe("tool_call_cancelled");
      }
    },
  };
}

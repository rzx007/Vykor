import { describe, expect, it } from "vitest";
import { readUsageReport, defaultUsageSettings, type UsageSettings } from "./usage-settings.js";

function source() {
  const events = [
    { id: "start-one", sessionId: "root", type: "session.model.attempt.started", createdAt: 90, payload: { runId: "r1", generationId: "g", attempt: 1 } },
    { id: "start-two", sessionId: "root", type: "session.model.attempt.started", createdAt: 105, payload: { runId: "r1", generationId: "g", attempt: 2 } },
    { id: "start-child", sessionId: "child", type: "session.model.attempt.started", createdAt: 115, payload: { runId: "r2", generationId: "g2", attempt: 1 } },
    { id: "one", sessionId: "root", type: "session.model.attempt.finished", createdAt: 100, payload: { runId: "r1", attemptUsage: { generationId: "g", attempt: 1, status: "failed", usageStatus: "unknown" } } },
    { id: "two", sessionId: "root", type: "session.model.attempt.finished", createdAt: 110, payload: { runId: "r1", attemptUsage: { generationId: "g", attempt: 2, status: "completed", usageStatus: "complete", usage: { inputTokens: 12, outputTokens: 0, cacheReadTokens: 2, cacheCreationTokens: 0 } } } },
    { id: "duplicate", sessionId: "root", type: "session.model.attempt.finished", createdAt: 110, payload: { runId: "r1", attemptUsage: { generationId: "g", attempt: 2, status: "completed", usageStatus: "complete", usage: { inputTokens: 12, outputTokens: 0, cacheReadTokens: 2, cacheCreationTokens: 0 } } } },
    { id: "child", sessionId: "child", type: "session.model.attempt.finished", createdAt: 120, payload: { runId: "r2", attemptUsage: { generationId: "g2", attempt: 1, status: "failed", usageStatus: "partial", usage: { inputTokens: 3, outputTokens: 2 } } } },
  ];
  return { sessions: { list: () => [{ id: "root", cwd: "/p", model: "m" }, { id: "child", cwd: "/p", model: "m" }, { id: "legacy", cwd: "/old", model: "m" }] },
    runs: { listRuns: (id: string) => [{ id: id === "root" ? "r1" : id === "child" ? "r2" : "r3", metadata: { usage: { inputTokens: 99999 } } }], listRunAttempts: () => [{ id: "a", provider: "p", model: "m", createdAt: 1, inputTokens: 0, outputTokens: 0, status: "completed" }] },
    conversations: { listEvents: ({ sessionId }: { sessionId: string }) => events.filter(event => event.sessionId === sessionId) } } as unknown as Parameters<typeof readUsageReport>[0];
}
describe("maintenance request usage", () => {
  it("counts retries and child requests once, preserves unknown and genuine zero, ignores run rollups", () => {
    const report = readUsageReport(source(), { project: "/p" });
    expect(report.totals).toMatchObject({ requests: 3, unknown: 1, partial: 1, input: 15, output: 2, cacheRead: 2 });
    expect(report.requests.find(row => row.id === "r1:g:1")?.inputTokens).toBeNull();
    expect(report.requests.find(row => row.id === "r1:g:2")?.outputTokens).toBe(0);
    expect(report.requests.every(row => row.cost === null)).toBe(true);
    expect(report.options.projects).toEqual(["/old", "/p"]);
  });
  it("filters by request time and keeps price adoption history and subscription costs separate", () => {
    const settings: UsageSettings = { ...defaultUsageSettings, prices: [{ provider: "p", model: "m", currency: "USD", source: "price-table", adoptedAt: 100, subscription: false, inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.5, cacheCreationPerMillion: 0 }, { provider: "p", model: "m", currency: "EUR", source: "new-table", adoptedAt: 200, subscription: false, inputPerMillion: 100, outputPerMillion: 100, cacheReadPerMillion: 0, cacheCreationPerMillion: 0 }] };
    const report = readUsageReport(source(), { from: 105, to: 115, provider: "p", model: "m" }, settings);
    expect(report.requests).toHaveLength(1);
    expect(report.requests[0]!.cost).toMatchObject({ currency: "USD", adoptedAt: 100, source: "price-table", kind: "estimate" });
    expect(report.requests[0]!.cost?.amount).toBeCloseTo(0.000011);
    settings.prices[0]!.subscription = true;
    expect(readUsageReport(source(), { from: 105, to: 115 }, settings).requests[0]!.cost).toBeNull();
  });
  it("keeps unfinished started attempts unknown and applies the price adopted before request start", () => {
    const store = source(); const original = store.conversations.listEvents.bind(store.conversations);
    store.conversations.listEvents = ((options: { sessionId: string }) => [...original(options), ...(options.sessionId === "root" ? [{ id: "unfinished", type: "session.model.attempt.started", createdAt: 130, payload: { runId: "r1", generationId: "later", attempt: 1 } }] : [])]) as typeof store.conversations.listEvents;
    const report = readUsageReport(store, { project: "/p" });
    expect(report.totals).toMatchObject({ requests: 4, unknown: 2 });
    expect(report.requests.find(request => request.id === "r1:later:1")).toMatchObject({ status: "unfinished", completeness: "unknown", inputTokens: null, cost: null });
    expect(report.warnings.join(" ")).toContain("不证明");
  });
});

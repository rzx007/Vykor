import type { SessionStore } from "@vykor/services";
import { readSessionModelAttemptUsage, type UsageFilter, type UsageRequest, type UsagePrice, type UsageSettings, type UsageReport } from "@vykor/protocol";
export type { UsageFilter, UsageRequest, UsagePrice, UsageSettings, UsageReport } from "@vykor/protocol";
export const defaultUsageSettings: UsageSettings = { version: 1, prices: [], budget: { enabled: false, tokens: null, amount: null, currency: "USD" } };

/** Finished model events identify individual network retries. Run totals are never added again. */
export function readUsageReport(store: Pick<SessionStore, "sessions" | "runs" | "conversations" | "projects">, filter: UsageFilter, settings = defaultUsageSettings): UsageReport {
  const records = new Map<string, UsageRequest>();
  const warnings = new Set<string>();
  for (const session of store.sessions.list({ includeArchived: true })) {
    const project = session.projectId ? store.projects?.get(session.projectId)?.path ?? session.cwd : session.cwd;
    const runs = store.runs.listRuns(session.id);
    const events = store.conversations.listEvents({ sessionId: session.id });
    for (const run of runs) {
      const attempts = store.runs.listRunAttempts(run.id);
      const started = events.filter(event => event.type === "session.model.attempt.started" && event.payload.runId === run.id);
      const startedRecords = new Map<string, UsageRequest>();
      const finished = events.filter(event => event.type === "session.model.attempt.finished" && event.payload.runId === run.id);
      for (const event of started) {
        const payload = event.payload;
        if (typeof payload.generationId !== "string" || !Number.isSafeInteger(payload.attempt) || Number(payload.attempt) < 1) { warnings.add("存在无法读取的请求开始记录。"); continue; }
        const attempt = attempts.filter(item => item.createdAt <= event.createdAt).at(-1);
        const id = `${run.id}:${payload.generationId}:${Number(payload.attempt)}`;
        if (!records.has(id)) records.set(id, { id, time: event.createdAt, project, sessionId: session.id, runId: run.id,
          provider: typeof payload.provider === "string" ? payload.provider : attempt?.provider ?? "unknown", model: typeof payload.model === "string" ? payload.model : attempt?.model ?? session.model,
          status: "unfinished", completeness: "unknown", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, cost: null });
        startedRecords.set(id, records.get(id)!);
      }
      for (const event of finished) {
        const usage = readSessionModelAttemptUsage(event.payload.attemptUsage);
        if (!usage) { warnings.add("存在无法读取的请求用量事件。"); continue; }
        const attempt = attempts.filter(item => item.createdAt <= event.createdAt).at(-1) ?? attempts.at(-1);
        const id = `${run.id}:${usage.generationId}:${usage.attempt}`;
        const beginning = startedRecords.get(id);
        const request: UsageRequest = {
          id, time: beginning?.time ?? event.createdAt, project, sessionId: session.id, runId: run.id,
          provider: beginning?.provider ?? attempt?.provider ?? "unknown", model: beginning?.model ?? attempt?.model ?? session.model,
          status: usage.status, completeness: usage.usageStatus,
          inputTokens: usage.usage?.inputTokens ?? null, outputTokens: usage.usage?.outputTokens ?? null,
          cacheReadTokens: usage.usage?.cacheReadTokens ?? null, cacheCreationTokens: usage.usage?.cacheCreationTokens ?? null,
          cost: null,
        };
        const price = settings.prices.filter(price => price.provider === request.provider && price.model === request.model && price.adoptedAt <= request.time).at(-1);
        if (price?.subscription && beginning) request.subscription = true;
        if (price && beginning && !price.subscription && request.completeness === "complete" && request.inputTokens !== null && request.outputTokens !== null &&
          (price.cacheReadPerMillion === 0 || request.cacheReadTokens !== null) && (price.cacheCreationPerMillion === 0 || request.cacheCreationTokens !== null)) {
          const billedInput = price.inputIncludesCache === false ? request.inputTokens : Math.max(0, request.inputTokens - (request.cacheReadTokens ?? 0) - (request.cacheCreationTokens ?? 0));
          request.cost = { amount: (billedInput * price.inputPerMillion + request.outputTokens * price.outputPerMillion + (request.cacheReadTokens ?? 0) * price.cacheReadPerMillion + (request.cacheCreationTokens ?? 0) * price.cacheCreationPerMillion) / 1_000_000,
            currency: price.currency, kind: "estimate", source: price.source, adoptedAt: price.adoptedAt, price: { ...price, inputIncludesCache: price.inputIncludesCache !== false } };
          if (!Number.isFinite(request.cost.amount)) { request.cost = null; warnings.add("价格或用量超出可计算范围，费用保持未知。"); }
        }
        if (!beginning) warnings.add("部分历史请求未保存开始时间，显示完成时间；费用依据无法证明，不追溯估算。");
        records.set(id, request);
      }
      if (!finished.length && !started.length && attempts.length) {
        warnings.add("部分历史或进行中的任务没有逐次模型事件；无法重建精确请求数、缓存或费用。以下按持久尝试列出，标为未知，不使用任务汇总补算。");
        for (const attempt of attempts) records.set(`legacy:${attempt.id}`, {
          id: `legacy:${attempt.id}`, time: attempt.createdAt, project, sessionId: session.id, runId: run.id,
          provider: attempt.provider ?? "unknown", model: attempt.model ?? session.model, status: attempt.status,
          completeness: "unknown", inputTokens: attempt.inputTokens ?? null, outputTokens: attempt.outputTokens ?? null,
          cacheReadTokens: null, cacheCreationTokens: null, cost: null,
        });
      }
      if (!finished.length && !started.length && !attempts.length && run.metadata.usage) warnings.add("部分历史任务只剩用量汇总，逐次事件已清理或不存在；无法重建请求数，本页不补造记录。");
    }
  }
  const all = [...records.values()];
  const requests = all.filter(row => (filter.from === undefined || row.time >= filter.from) && (filter.to === undefined || row.time < filter.to) && (!filter.project || row.project === filter.project) && (!filter.provider || row.provider === filter.provider) && (!filter.model || row.model === filter.model)).sort((a, b) => b.time - a.time);
  if (requests.some(request => request.status === "unfinished")) warnings.add("存在已开始但未收到完成用量的尝试，按未知列出；开始记录不证明供应商已收到请求或发生扣款。");
  const totals: UsageReport["totals"] = { requests: requests.length, unknown: 0, partial: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costs: {} };
  for (const row of requests) {
    if (row.completeness !== "complete") totals[row.completeness]++;
    totals.input += row.inputTokens ?? 0; totals.output += row.outputTokens ?? 0;
    totals.cacheRead += row.cacheReadTokens ?? 0; totals.cacheCreation += row.cacheCreationTokens ?? 0;
    if (row.cost) totals.costs[row.cost.currency] = (totals.costs[row.cost.currency] ?? 0) + row.cost.amount;
  }
  return { scannedAt: Date.now(), requests, warnings: [...warnings], totals, settings, options: {
    projects: [...new Set(all.map(row => row.project))].sort(), providers: [...new Set(all.map(row => row.provider))].sort(), models: [...new Set(all.map(row => row.model))].sort(),
  } };
}

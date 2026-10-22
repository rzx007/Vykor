import type { SessionEventRecord, SessionMessagePartRecord } from "@vykor/protocol";
import { publicToolResult } from "@vykor/agent-contracts";

const fullBodyByteLimit = 4096;
const previewChars = 512;
const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? "");
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

// Keep this wire-view module usable by client-side rendering contract tests.
// Only recover bounded identity here; the canonical result remains unchanged.
function workflowNotificationRunId(text: string): string | undefined {
  const match = text.match(/<workflow-notification>\s*<payload>([\s\S]*?)<\/payload>\s*<\/workflow-notification>/);
  if (!match) return undefined;
  try {
    const payload = record(JSON.parse(match[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")));
    return typeof payload.runId === "string" && ["completed", "failed"].includes(String(payload.status)) && Array.isArray(payload.tasks) ? payload.runId : undefined;
  } catch { return undefined; }
}

/** Public transcript reads exclude page-private data; raw bodies stay in durable storage. */
export function publicPart(part: SessionMessagePartRecord): SessionMessagePartRecord {
  return { ...part, ...(part.output !== undefined ? { output: publicToolResult(part.output) } : {}), metadata: publicToolResult(part.metadata) as Record<string, unknown> };
}

/** Only HTTP summary consumers opt in. Canonical parts and durable events remain full. */
export function summarizePart(part: SessionMessagePartRecord): SessionMessagePartRecord {
  part = publicPart(part);
  if (part.type !== "tool" && part.type !== "tool_result") return part;
  const inputView = part.input === undefined ? "unavailable" : byteLength(part.input) > fullBodyByteLimit ? "preview" : "full";
  const outputView = part.output === undefined ? "unavailable" : byteLength(part.output) > fullBodyByteLimit ? "preview" : "full";
  let input = part.input;
  let output = part.output;
  let metadata = part.metadata;
  if (part.toolName === "Workflow" || (!part.toolName && part.type === "tool_result")) {
    const result = record(part.output);
    const blocks = Array.isArray(result.content) ? result.content : [];
    const text = typeof part.output === "string" ? part.output : blocks.map(block => record(block).text).filter((value): value is string => typeof value === "string").join("\n");
    let runId = workflowNotificationRunId(text);
    if (!runId && part.toolName === "Workflow") {
      try {
        const job = record(JSON.parse(text));
        if (job.kind === "job" && job.jobKind === "workflow" && job.action === "created" && typeof job.jobId === "string" && job.jobId.startsWith("workflow:")) runId = job.jobId.slice(9);
      } catch { /* Other domain actions keep their normal result. */ }
    }
    if (runId && runId.length <= 256) metadata = { ...metadata, workflowRunId: runId };
  }
  const references = new Set<string>();
  if (inputView === "preview") {
    input = {};
    let source = part.input;
    let context = input;
    // File tools already accept these sole-field envelopes at the engine boundary.
    // Keep their shape for display; never validate or correct execution arguments here.
    if (["Write", "Edit", "Read"].includes(part.toolName ?? "")) {
      for (let depth = 0; source && depth < 8; depth++) {
        const keys = Object.keys(source);
        const key = keys[0];
        if (keys.length !== 1 || !key || !["arguments", "args", "parameters"].includes(key) || !source[key] || typeof source[key] !== "object" || Array.isArray(source[key])) break;
        source = source[key] as Record<string, unknown>;
        context = context[key] = {};
      }
    }
    // Keep list context; omitted arguments are explicitly marked as previews.
    for (const key of ["file_path", "filePath", "path", "command", "description", "query", "url"]) {
      const value = source?.[key];
      if (typeof value === "string" && value.length <= 256) context[key] = value;
    }
    const ratio = part.input?.ratio;
    if (part.toolName === "Workflow") {
      for (const key of ["action", "runId"]) {
        const value = part.input?.[key];
        if (typeof value === "string" && value.length <= 256) input[key] = value;
      }
    }
    if (part.toolName === "ImageGeneration" && typeof ratio === "string" && ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"].includes(ratio)) input.ratio = ratio;
  }
  if (outputView === "preview") {
    const result = record(part.output);
    const blocks = Array.isArray(result.content) ? result.content : [];
    const text = typeof part.output === "string" ? part.output : blocks.map(block => record(block).text).filter((text): text is string => typeof text === "string").join("\n") || JSON.stringify(part.output);
    for (const ref of text.matchAll(/shell-output:\/\/[a-zA-Z0-9-]{1,64}(?![a-zA-Z0-9-])/g)) {
      if (references.size < 8) references.add(ref[0]);
    }
    const preview: Record<string, unknown> = { content: [{ type: "text", text: text.slice(0, previewChars) }] };
    if (part.toolName === "Agent") {
      try {
        const job = record(JSON.parse(text));
        // The existing Agent card reads this producer-owned task identity, not the label body.
        if (job.kind === "job" && job.action === "created" && job.jobKind === "agent" && typeof job.jobId === "string" && job.jobId.length <= 256) {
          preview.content = [{ type: "text", text: JSON.stringify({ kind: "job", action: "created", jobKind: "agent", jobId: job.jobId, ...(typeof job.label === "string" ? { label: job.label.slice(0, 256) } : {}) }) }];
        }
      } catch { /* Other Agent results retain the ordinary explicitly marked text preview. */ }
    }
    if (/^(?:shell|bash)$/i.test(part.toolName ?? "")) {
      let remainingNoticeBytes = 1024;
      for (const block of blocks.slice(1)) {
        const notice = record(block).text;
        if (typeof notice !== "string" || !/^(?:\[tool-output-ref: shell-output:\/\/|Shell 日志|预览省略的内容已留存。)/.test(notice)) continue;
        const size = Buffer.byteLength(notice);
        if (size > remainingNoticeBytes) continue;
        (preview.content as Array<{ type: string; text: string }>).push({ type: "text", text: notice });
        remainingNoticeBytes -= size;
      }
    }
    for (const key of ["isError", "failureKind", "executionState", "recoveryHint", "compactSummary"]) {
      const value = result[key];
      if (typeof value === "boolean") preview[key] = value;
      else if (typeof value === "string") preview[key] = value.slice(0, 256);
    }
    // Older tools may expose the same resource reference in result metadata.
    const uri = record(result.metadata).outputResourceUri;
    if (typeof uri === "string" && /^shell-output:\/\/[a-zA-Z0-9-]{1,64}$/.test(uri)) references.add(uri);
    output = preview;
  }
  return { ...part, input, output, metadata, bodyView: { input: inputView, output: outputView, ...(references.size ? { outputReferences: [...references].slice(0, 8) } : {}) } };
}

export function publicPartEvent(event: SessionEventRecord, summarize = false): SessionEventRecord {
  const view = summarize ? summarizePart : publicPart;
  if (event.type === "session.message.part.updated") {
    return { ...event, payload: { ...event.payload, part: view(event.payload.part as SessionMessagePartRecord) } };
  }
  if (event.type === "session.transcript.replaced" && Array.isArray(event.payload.parts)) {
    return { ...event, payload: { ...event.payload, parts: (event.payload.parts as SessionMessagePartRecord[]).map(view) } };
  }
  return event;
}

export function summarizePartEvent(event: SessionEventRecord): SessionEventRecord {
  return publicPartEvent(event, true);
}

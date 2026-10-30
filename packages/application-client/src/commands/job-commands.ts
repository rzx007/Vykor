import type { JobReadResult, JobSnapshot, JobTarget } from "@vykor/protocol";
import type { SessionCommandHost, SlashLine } from "./session-commands.js";

type ReadPresentation = (key: string, title: string, load: () => Promise<string>) => Promise<void>;

function formatJobReadResult(result: JobReadResult): string {
  const snapshot: JobSnapshot = result.snapshot;
  const capabilities = [
    `read=${snapshot.capabilities.read}`,
    `wait=${snapshot.capabilities.wait}`,
    `send=${snapshot.capabilities.send}`,
    `cancel=${snapshot.capabilities.cancel}`,
  ].join(", ");
  return [
    `Job: ${snapshot.id}`,
    `  Kind:          ${snapshot.kind}`,
    `  Status:        ${snapshot.status}`,
    `  Label:         ${snapshot.label}`,
    `  Owner session: ${snapshot.ownerSession}`,
    `  CWD:           ${snapshot.cwd}`,
    `  Started at:    ${snapshot.startedAt}`,
    `  Updated at:    ${snapshot.updatedAt}`,
    `  Finished at:   ${snapshot.finishedAt ?? "(n/a)"}`,
    `  Detail:        ${snapshot.detail ?? "(none)"}`,
    `  Capabilities:  ${capabilities}`,
    `  Metadata:      ${snapshot.metadata ? JSON.stringify(snapshot.metadata) : "(none)"}`,
    `  Cursor:        ${result.cursor}`,
    `  Truncated:     ${result.truncated}`,
    "",
    "Output:",
    result.text || "(no output)",
  ].join("\n");
}

export async function handleJobCommand(
  slash: SlashLine,
  host: Pick<SessionCommandHost, "client" | "sessionId">,
  emit: (text: string) => void,
  readPresentation: ReadPresentation,
): Promise<"handled"> {
  const { client, sessionId } = host;
  if (slash.name === "/background") {
    const command = slash.args.trim();
    if (!command) {
      emit("Usage: /background <command>");
      return "handled";
    }
    if (!sessionId) return "handled";
    const result = await client.jobs.createBackgroundShell({ sessionId, command });
    emit(`Background shell started: ${result.jobId}. Use /jobs to inspect it.`);
    return "handled";
  }

  if (!sessionId) return "handled";
  const args = slash.args.trim();
  const [sub, kind, id, runId, ...extra] = args.split(/\s+/).filter(Boolean);
  if ((!sub || sub === "list") && !kind) {
    await readPresentation(`jobs:${sessionId}`, "Jobs", async () => {
      const listed = await client.jobs.list({
        sessionId,
        includeFinished: true,
        limit: 100,
      });
      const { jobs, errors } = listed;
      if (jobs.length === 0 && errors.length === 0) return "No Jobs.";
      return [
        `Jobs (${jobs.length}):`,
        "",
        ...jobs.map((job) => `  ${job.id} [${job.status}] ${job.kind}: ${job.label}${job.target.kind === "agent" ? ` runId=${job.target.runId}` : ""}`),
        ...errors.map(error => `${error.kind}: ${error.message}`),
      ].join("\n");
    });
    return "handled";
  }
  const target: JobTarget | undefined = kind === "agent" && id && runId ? { kind, jobId: id, runId } : ["shell", "terminal", "workflow", "dream"].includes(kind ?? "") && id && !runId ? { kind: kind as "shell" | "terminal" | "workflow" | "dream", jobId: id } : undefined;
  if (sub === "show" && target && extra.length === 0) {
    await readPresentation(`job:${sessionId}:${id}`, "Jobs", async () => {
      const result = await client.jobs.read(target, { sessionId });
      return formatJobReadResult(result);
    });
    return "handled";
  }
  if (sub === "cancel" && target && extra.length === 0) {
    const snapshot = await client.jobs.cancel(target, {
      sessionId,
      reason: "Cancelled from slash command",
    });
    emit(`Job ${snapshot.id} status: ${snapshot.status}.`);
    return "handled";
  }
  emit("Usage: /jobs [list | show KIND ID [RUN_ID] | cancel KIND ID [RUN_ID]]");
  return "handled";
}

import { TextAttributes } from "@opentui/core";
import { useTheme } from "../../theme/ThemeContext";
import { parseStatus } from "../../services/status";
import type { TranscriptItem, McpServerSnapshot } from "../../types";

export type ModifiedFile = {
  path: string;
  added: number;
  removed: number;
};

export function computeModifiedFiles(transcript: TranscriptItem[]): ModifiedFile[] {
  const map = new Map<string, ModifiedFile>();
  for (const item of transcript) {
    if (item.role !== "tool") continue;
    const name = item.tool_name ?? "";
    const isEdit = name === "Edit" || name === "str_replace_editor";
    const isWrite = name === "Write" || name === "create_file";
    if (!isEdit && !isWrite) continue;

    const path = String(item.tool_input?.path ?? item.tool_input?.file_path ?? "");
    if (!path) continue;

    if (isEdit) {
      const old = String(item.tool_input?.old_string ?? "");
      const next = String(item.tool_input?.new_string ?? "");
      map.set(path, { path, added: next.split("\n").length, removed: old.split("\n").length });
    } else {
      const content = String(item.tool_input?.content ?? "");
      map.set(path, { path, added: content.split("\n").length, removed: 0 });
    }
  }
  return Array.from(map.values());
}

export type WorkflowPanelTask = {
  id: string;
  status: string;
  detail?: string;
};

export type WorkflowPanelState = {
  runId?: string;
  status: string;
  summary?: string;
  mode?: string;
  totalTasks?: number;
  completedTasks?: number;
  failedTasks?: number;
  runningTasks?: number;
  pendingTasks?: number;
  blockedTasks?: number;
  needsReconciliation?: boolean;
  tasks: WorkflowPanelTask[];
};

export function computeWorkflowPanel(transcript: TranscriptItem[]): WorkflowPanelState | undefined {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const text = transcript[i]?.text ?? "";
    const snapshotPayload = parseWorkflowPayload(text, "workflow-run-snapshot");
    const fromSnapshot = snapshotPayload ? workflowPanelFromSnapshotPayload(snapshotPayload) : undefined;
    if (fromSnapshot) return fromSnapshot;

    const notificationPayload = parseWorkflowPayload(text, "workflow-notification");
    const fromNotification = notificationPayload ? workflowPanelFromNotification(notificationPayload) : undefined;
    if (fromNotification) return fromNotification;
  }
  return undefined;
}

function parseWorkflowPayload(text: string, tag: string): Record<string, unknown> | undefined {
  const match = text.match(new RegExp(`<${tag}>\\s*<payload>([\\s\\S]*?)<\\/payload>\\s*<\\/${tag}>`));
  if (!match) return undefined;
  try {
    const payload = JSON.parse(unescapeXml(match[1]!));
    return isRecord(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

function workflowPanelFromSnapshotPayload(payload: Record<string, unknown>): WorkflowPanelState | undefined {
  const snapshot = asRecord(payload.snapshot);
  if (!snapshot) return undefined;
  const plan = asRecord(snapshot.plan);
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks.filter(isRecord) : [];
  const results = asRecord(snapshot.results) ?? {};
  const runningTasks = asRecord(snapshot.runningTasks) ?? {};
  const blockedTasks = asRecord(snapshot.blockedTasks) ?? {};
  const runningIds = new Set(stringArray(snapshot.runningTaskIds));
  const pendingIds = new Set(stringArray(snapshot.pendingTaskIds));
  const blockedIds = new Set(stringArray(snapshot.blockedTaskIds));

  return {
    runId: stringValue(snapshot.runId),
    status: stringValue(snapshot.status) ?? "unknown",
    summary: stringValue(snapshot.summary),
    mode: stringValue(plan?.mode),
    totalTasks: tasks.length,
    completedTasks: Object.values(results).filter((result) => stringValue(asRecord(result)?.status) === "completed").length,
    failedTasks: Object.values(results).filter((result) => {
      const status = stringValue(asRecord(result)?.status);
      return status === "failed" || status === "skipped";
    }).length,
    runningTasks: runningIds.size,
    pendingTasks: pendingIds.size,
    blockedTasks: blockedIds.size,
    tasks: tasks.map((task) => {
      const id = stringValue(task.id) ?? "task";
      const result = asRecord(results[id]);
      const running = asRecord(runningTasks[id]);
      const blocked = asRecord(blockedTasks[id]);
      const status = stringValue(result?.status)
        ?? (blockedIds.has(id) ? "blocked" : undefined)
        ?? (runningIds.has(id) ? "running" : undefined)
        ?? (pendingIds.has(id) ? "pending" : undefined)
        ?? "pending";
      return {
        id,
        status,
        detail: stringValue(result?.summary)
          ?? stringValue(running?.summary)
          ?? stringValue(blocked?.reason)
          ?? stringValue(task.description),
      };
    }),
  };
}

function workflowPanelFromNotification(payload: Record<string, unknown>): WorkflowPanelState | undefined {
  const tasks = Array.isArray(payload.tasks) ? payload.tasks.filter(isRecord) : [];
  const totalTasks = numberValue(payload.totalTasks);
  const completedTasks = numberValue(payload.completedTasks);
  const failedTasks = numberValue(payload.failedTasks);
  return {
    runId: stringValue(payload.runId),
    status: stringValue(payload.status) ?? "unknown",
    summary: stringValue(payload.summary),
    mode: stringValue(payload.mode),
    totalTasks,
    completedTasks,
    failedTasks,
    runningTasks: 0,
    pendingTasks: totalTasks !== undefined && completedTasks !== undefined && failedTasks !== undefined
      ? Math.max(0, totalTasks - completedTasks - failedTasks)
      : undefined,
    blockedTasks: 0,
    needsReconciliation: booleanValue(payload.needsReconciliation),
    tasks: tasks.map((task) => ({
      id: stringValue(task.taskId) ?? "task",
      status: stringValue(task.status) ?? "unknown",
      detail: stringValue(task.summary) ?? stringValue(task.error) ?? stringValue(task.skippedReason),
    })),
  };
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return `${value.slice(0, max - 3)}...`;
}

function workflowTaskCounts(workflow: WorkflowPanelState): string {
  const parts = [
    workflow.completedTasks !== undefined ? `${workflow.completedTasks} done` : undefined,
    workflow.runningTasks ? `${workflow.runningTasks} running` : undefined,
    workflow.blockedTasks ? `${workflow.blockedTasks} blocked` : undefined,
    workflow.pendingTasks ? `${workflow.pendingTasks} pending` : undefined,
    workflow.failedTasks ? `${workflow.failedTasks} failed` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.join(" ");
}

function statusColor(status: string, colors: { success: string; warning: string; error: string; muted: string; foreground: string }): string {
  if (status === "done" || status === "completed") return colors.success;
  if (status === "running") return colors.success;
  if (status === "idle" || status === "pending" || status === "blocked" || status === "skipped") return colors.warning;
  if (status === "error" || status === "failed" || status === "timed-out") return colors.error;
  return colors.muted;
}

function SectionHeader({ title, muted }: { title: string; muted: string }) {
  return (
    <text fg={muted} attributes={TextAttributes.BOLD}>
      {" " + title.toUpperCase()}
    </text>
  );
}

export type SidebarProps = {
  status: Record<string, unknown>;
  transcript: TranscriptItem[];
  mcpServers: McpServerSnapshot[];
  version?: string | null;
};

export function Sidebar({
  status,
  transcript,
  mcpServers,
}: SidebarProps) {
  const { theme } = useTheme();
  const c = theme.colors;

  const { mode, model, effort, inputTokens, outputTokens } = parseStatus(status);
  const workMode = status.work_mode ?? (status.permission_mode === "plan" ? "plan" : "execute");

  const modifiedFiles = computeModifiedFiles(transcript);
  const workflow = computeWorkflowPanel(transcript);
  const shownFiles = modifiedFiles.slice(0, 15);
  const extraFiles = modifiedFiles.length - shownFiles.length;

  return (
    <box
      flexDirection="column"
      width={40}
      flexShrink={0}
      borderColor={c.muted}
      border={["left"]}
      customBorderChars={{
        topLeft: "", bottomLeft: "", vertical: "│",
        topRight: "", bottomRight: "", horizontal: " ",
        bottomT: "", topT: "", cross: "", leftT: "", rightT: "",
      }}
    >
      <SectionHeader title="Session" muted={c.muted} />
      {model ? <text fg={c.foreground}>{" " + model}</text> : null}
      {mode ? <text fg={c.muted}>{" approval: " + mode}</text> : null}
      <text fg={c.muted}>{" work: " + String(workMode)}</text>
      {effort ? <text fg={c.warning}>{" effort: " + effort}</text> : null}
      {(inputTokens > 0 || outputTokens > 0) ? (
        <text fg={c.muted}>{` ${inputTokens}↓ ${outputTokens}↑`}</text>
      ) : null}

      {shownFiles.length > 0 ? (
        <box flexDirection="column">
          <text>{" "}</text>
          <SectionHeader title="Modified" muted={c.muted} />
          {shownFiles.map((f) => (
            <text key={f.path} fg={c.muted}>
              <span fg={c.success}>{`+${f.added}`}</span>
              <span fg={c.error}>{`-${f.removed}`}</span>
              {" " + f.path.split("/").pop()}
            </text>
          ))}
          {extraFiles > 0 ? <text fg={c.muted}>{`  +${extraFiles} more`}</text> : null}
        </box>
      ) : null}

      {workflow ? (
        <box flexDirection="column">
          <text>{" "}</text>
          <SectionHeader title="Workflow" muted={c.muted} />
          <text fg={c.muted}>
            <span fg={statusColor(workflow.status, c)}>{" ●"}</span>
            {" " + truncate(workflow.runId ?? "latest", 18)}
            {" " + truncate(workflow.status, 10)}
          </text>
          {workflow.mode ? <text fg={c.muted}>{" mode: " + workflow.mode}</text> : null}
          {workflowTaskCounts(workflow) ? <text fg={c.muted}>{" " + truncate(workflowTaskCounts(workflow), 34)}</text> : null}
          {workflow.needsReconciliation ? <text fg={c.warning}>{" needs reconciliation"}</text> : null}
          {workflow.tasks.slice(0, 5).map((task) => (
            <box key={task.id} flexDirection="column">
              <text fg={c.muted}>
                <span fg={statusColor(task.status, c)}>{"  ●"}</span>
                {" " + truncate(task.id, 18)}
                {" " + truncate(task.status, 10)}
              </text>
              {task.detail ? <text fg={c.foreground}>{"   " + truncate(task.detail, 32)}</text> : null}
            </box>
          ))}
          {workflow.tasks.length > 5 ? <text fg={c.muted}>{`  +${workflow.tasks.length - 5} more`}</text> : null}
        </box>
      ) : null}

      {mcpServers.length > 0 ? (
        <box flexDirection="column">
          <text>{" "}</text>
          <SectionHeader title="MCP" muted={c.muted} />
          {mcpServers.map((s) => {
            const dot = s.state === "connected" || s.state === "ok" ? "●" : "○";
            const dotColor = s.state === "error" ? c.error
              : (s.state === "connected" || s.state === "ok") ? c.success
              : c.muted;
            const tools = s.tool_count ? ` (${s.tool_count})` : "";
            return (
              <text key={s.name} fg={c.muted}>
                <span fg={dotColor}>{dot}</span>
                {" " + s.name.slice(0, 32) + tools}
              </text>
            );
          })}
        </box>
      ) : null}
    </box>
  );
}

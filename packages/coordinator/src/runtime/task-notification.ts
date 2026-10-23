import type { TaskNotification } from "./types.js";

export function formatTaskNotification(notification: TaskNotification): string {
  const lines = [
    "<task-notification>",
    `<task-id>${notification.taskId}</task-id>`,
    `<status>${notification.status}</status>`,
    `<summary>${notification.summary}</summary>`,
  ];
  if (notification.result) {
    lines.push(`<result>${notification.result}</result>`);
  }
  if (notification.usage) {
    lines.push(
      "<usage>",
      `  <total_tokens>${notification.usage.totalTokens}</total_tokens>`,
      `  <tool_uses>${notification.usage.toolUses}</tool_uses>`,
      `  <duration_ms>${notification.usage.durationMs}</duration_ms>`,
      "</usage>",
    );
  }
  lines.push("</task-notification>");
  return lines.join("\n");
}

export function parseTaskNotification(text: string): TaskNotification | undefined {
  const match = text.match(/<task-notification>([\s\S]*?)<\/task-notification>/);
  if (!match) return undefined;

  const body = match[1]!;

  const taskId = body.match(/<task-id>(.*?)<\/task-id>/)?.[1];
  const status = body.match(/<status>(.*?)<\/status>/)?.[1] as TaskNotification["status"];
  const summary = body.match(/<summary>(.*?)<\/summary>/)?.[1];
  const result = body.match(/<result>([\s\S]*?)<\/result>/)?.[1]?.trim();

  if (!taskId || !status || !summary) return undefined;

  const usageBlock = body.match(/<usage>([\s\S]*?)<\/usage>/)?.[1];
  let usage: TaskNotification["usage"];
  if (usageBlock) {
    usage = {
      totalTokens: parseInt(usageBlock.match(/<total_tokens>(\d+)/)?.[1] ?? "0", 10),
      toolUses: parseInt(usageBlock.match(/<tool_uses>(\d+)/)?.[1] ?? "0", 10),
      durationMs: parseInt(usageBlock.match(/<duration_ms>(\d+)/)?.[1] ?? "0", 10),
    };
  }

  return { taskId, status, summary, result, usage };
}

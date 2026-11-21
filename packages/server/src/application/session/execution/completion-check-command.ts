import { normalizeSessionUserInputItems, type SessionUserInputItem } from "@vykor/domain-contracts/inputs";
import { SessionApplicationError } from "../session-application-error.js";

export function readCompletionCheckCommand(
  items: readonly SessionUserInputItem[],
  destination?: "steer" | "live-child",
): string | undefined {
  const normalized = normalizeSessionUserInputItems(items);
  const firstItem = normalized[0];
  if (firstItem?.type !== "text") return;
  const firstLine = firstItem.text.split(/\r?\n/u, 1)[0]!;
  const command = /^(?:\/check(?:[ \t]+|$)|验收命令[:：])(.*)$/u.exec(firstLine)?.[1]?.trim();
  if (command === undefined) return;
  if (destination === "steer") {
    throw new SessionApplicationError(409, "带验收命令的消息需要单独运行，请选择排队。");
  }
  if (destination === "live-child") {
    throw new SessionApplicationError(409, "请在单独的普通对话中发送带验收命令的消息。");
  }
  if (normalized.length > 1 && !firstItem.text.includes("\n")) {
    throw new SessionApplicationError(400, "验收命令需要在首行写完整，请把引用放到下一行。");
  }
  if (!command || command.length > 4096 || /\p{Cc}/u.test(command)) {
    throw new SessionApplicationError(400, "请在 /check 后填写一条 Shell 命令（最多 4096 字符）。");
  }
  return command;
}

/**
 * 通道 ACL。
 *
 * fail-closed：空/缺失 allowFrom 一律拒绝——远程通道把消息直通引擎，
 * 默认必须显式授权。`"*"` 全放；发送者或会话（群）任一命中即放行；
 * id 支持 `"a|b"` 复合分段匹配（飞书 open_id|union_id 这类双 id 场景）。
 */
export interface AclSubject {
  sender: string;
  chatId?: string;
}

export function isAllowed(subject: AclSubject, allowFrom: string[] | undefined): boolean {
  if (!allowFrom || allowFrom.length === 0) return false;
  if (allowFrom.includes("*")) return true;
  const candidates = [subject.sender, subject.chatId].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return candidates.some((candidate) => {
    if (allowFrom.includes(candidate)) return true;
    return candidate.split("|").some((part) => part !== "" && allowFrom.includes(part));
  });
}

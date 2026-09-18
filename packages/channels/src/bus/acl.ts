/**
 * 通道 ACL。
 *
 * fail-closed：空/缺失 allowFrom 一律拒绝——远程通道把消息直通引擎，
 * 默认必须显式授权。`"*"` 全放；senderId 支持 `"a|b"` 复合 id 分段匹配
 * （飞书 open_id|union_id 这类双 id 场景）。
 */
export function isAllowed(senderId: string, allowFrom: string[] | undefined): boolean {
  if (!allowFrom || allowFrom.length === 0) return false;
  if (allowFrom.includes("*")) return true;
  const sender = String(senderId);
  if (allowFrom.includes(sender)) return true;
  return sender.split("|").some((part) => part !== "" && allowFrom.includes(part));
}

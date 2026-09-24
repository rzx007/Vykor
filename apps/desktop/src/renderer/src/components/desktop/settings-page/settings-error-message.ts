export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (raw.includes("Cannot update daemon settings while session runs are active")) {
    return "当前有任务正在运行。请等待任务结束或停止任务后，再修改该设置。"
  }
  if (/authorization was saved .* failed to reconnect/i.test(raw)) {
    return "授权已保存，但 MCP 重连失败。可稍后重试或查看 MCP 状态。"
  }
  if (/credentials were removed .* failed to disconnect/i.test(raw)) {
    return "凭据已删除，但 MCP 断开失败。可稍后重试或查看 MCP 状态。"
  }
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error|VykorApiError): /, "")
}

/** Electron preserves only the error message across IPC, including API error names. */
export function pluginErrorMessage(error: unknown): string {
  let message =
    typeof error === "string"
      ? error
      : error &&
          typeof error === "object" &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : ""

  for (let depth = 0; depth < 4; depth++) {
    const previous = message
    message = message
      .trim()
      .replace(/^Error invoking remote method (?:'[^']+'|"[^"]+"):\s*/, "")
      .replace(/^(?:Error|[A-Za-z_$][\w$]*Error)(?: \[[^\]]+\])?:\s*/, "")
    if (message === previous) break
  }

  if (/^Cannot uninstall plugins while session runs are active\.?$/i.test(message)) {
    return "当前有任务正在运行，请等待任务结束后再卸载插件。"
  }
  return message || "插件操作失败，未返回具体原因。"
}

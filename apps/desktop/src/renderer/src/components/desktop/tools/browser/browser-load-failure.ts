export type BrowserLoadFailure = {
  kind: "file" | "network" | "security" | "http" | "crash" | "unknown"
  title: string
  description: string
  url: string
  code: string
}

export function browserLoadFailure(
  url: string,
  errorCode: number,
  errorDescription: string
): BrowserLoadFailure | null {
  const code = errorDescription || `ERR_LOAD_FAILED (${errorCode})`
  if (errorCode === -3 || code === "ERR_ABORTED") return null
  const result = (
    kind: BrowserLoadFailure["kind"],
    title: string,
    description: string
  ): BrowserLoadFailure => ({ kind, title, description, url, code })
  if (/INVALID_URL|UNKNOWN_URL_SCHEME|DISALLOWED_URL_SCHEME/.test(code))
    return result("unknown", "无法识别这个地址", "请在上方输入完整的网址或本地文件路径。")
  if (/^file:/i.test(url)) {
    return errorCode === -6
      ? result("file", "找不到本地文件", "文件可能已被移动、重命名或删除。请确认路径后重试。")
      : result("file", "无法打开本地文件", "请确认文件路径和访问权限，然后重新加载。")
  }
  if (/^ERR_(?:CERT_|SSL_|TLS_)/.test(code) || (errorCode <= -200 && errorCode > -300))
    return result(
      "security",
      "无法建立安全连接",
      "网站证书或安全连接校验失败。请检查网址、系统时间，或联系网站维护者。"
    )
  if (errorCode === -106) return result("network", "网络已断开", "请检查网络连接，恢复后重新加载。")
  if (errorCode === -105 || errorCode === -137)
    return result(
      "network",
      "找不到这个网站",
      "无法解析网站地址。请检查网址是否拼写正确，或稍后重试。"
    )
  if (errorCode === -130 || errorCode === -111 || /PROXY|TUNNEL/.test(code))
    return result(
      "network",
      "无法连接代理服务",
      "请确认代理服务已启动，且代理设置正确，然后重新加载。"
    )
  if (errorCode === -102)
    return result(
      "network",
      "连接被拒绝",
      "网站或本地服务没有接受连接。请确认服务已启动，且地址和端口正确。"
    )
  if (errorCode === -7 || errorCode === -118)
    return result("network", "连接超时", "网站响应时间过长。请检查网络连接，或稍后重试。")
  if (/BLOCKED|ACCESS_DENIED/.test(code))
    return result(
      "security",
      "访问被拦截",
      "当前地址被浏览器或系统策略拦截。请检查地址和访问权限。"
    )
  return result("unknown", "页面加载失败", "页面未能完成加载。可以重新加载，或检查上方地址。")
}

export function browserHttpFailure(url: string, status: number): BrowserLoadFailure | null {
  if (!/^https?:/i.test(url) || !Number.isInteger(status) || status < 400 || status >= 600)
    return null
  const messages: Record<number, [string, string]> = {
    401: ["需要登录后访问", "网站要求验证身份。可以查看原网页，按网站提示登录后继续。"],
    403: ["没有访问权限", "网站拒绝了这次访问。可以检查账号权限，或查看网站的原始提示。"],
    404: ["页面不存在", "这个地址没有找到页面，链接可能已失效。请检查网址，或返回上一页。"],
    408: ["请求超时", "网站没有及时收到完整请求。请稍后重新加载。"],
    410: ["页面已被移除", "网站已移除此页面。可以返回上一页，或检查是否有新的地址。"],
    429: ["请求过于频繁", "网站暂时限制了访问频率。请稍等片刻再重新加载。"],
    504: ["网站响应超时", "网站的上游服务没有及时响应。请稍后重试。"],
  }
  const [title, description] =
    messages[status] ??
    (status >= 500
      ? ["网站暂时不可用", "网站服务遇到了问题。请稍后重试，或查看网站的原始提示。"]
      : ["页面暂时无法访问", "网站未能完成这次请求。请检查地址，或查看网站的原始提示。"])
  return { kind: "http", title, description, url, code: `HTTP ${status}` }
}

export function browserCrashFailure(url: string, reason: string): BrowserLoadFailure {
  return {
    kind: "crash",
    title: "页面意外退出",
    url,
    code: `RENDER_PROCESS_GONE (${reason})`,
    description:
      reason === "oom"
        ? "页面占用的内存过多。可以关闭其他高占用页面后重新加载。"
        : "页面进程已退出。重新加载可以尝试恢复，浏览器地址和其他标签仍会保留。",
  }
}

export function displayFailureUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === "file:")
      return decodeURIComponent(parsed.pathname).replace(/^\/(?=[a-z]:\/)/i, "")
    parsed.username = ""
    parsed.password = ""
    return parsed.href
  } catch {
    return url
  }
}

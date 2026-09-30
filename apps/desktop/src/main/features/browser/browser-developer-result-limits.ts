import type { BrowserDeveloperResult } from "@vykor/server"
import type { DeveloperDiagnosticsPage, DeveloperDomView } from "./browser-developer-inspector"

export function capDeveloperReadResult(result: BrowserDeveloperResult): BrowserDeveloperResult {
  const maxBytes = 48 * 1024
  if (result.url.length > 2_048) {
    result.url = result.url.slice(0, 2_048)
    result.truncated = true
  }
  const data = result.data as {
    document?: DeveloperDomView
    node?: DeveloperDomView
    properties?: unknown[]
  }
  while (Buffer.byteLength(JSON.stringify(result), "utf8") > maxBytes) {
    result.truncated = true
    if (data.properties?.length) {
      data.properties.pop()
    } else if (trimDomView(data.document ?? data.node)) {
      continue
    } else {
      result.data = { omitted: "Developer inspection result exceeded the size limit." }
      break
    }
  }
  return result
}

export function capDeveloperDiagnosticsResult(result: BrowserDeveloperResult): BrowserDeveloperResult {
  const page = result.data as DeveloperDiagnosticsPage
  while (Buffer.byteLength(JSON.stringify(result), "utf8") > 48 * 1024) {
    result.truncated = true
    page.truncated = true
    if (page.network.length) page.network.pop()
    else if (page.console.length) page.console.pop()
    else {
      result.data = { omitted: "Browser diagnostics result exceeded the size limit." }
      break
    }
  }
  return result
}

function trimDomView(view: DeveloperDomView | undefined): boolean {
  if (!view) return false
  if (view.children?.length) {
    view.children.pop()
    return true
  }
  if (view.attributes) {
    const last = Object.keys(view.attributes).at(-1)
    if (last) {
      delete view.attributes[last]
      return true
    }
  }
  if (view.text) {
    delete view.text
    return true
  }
  return false
}

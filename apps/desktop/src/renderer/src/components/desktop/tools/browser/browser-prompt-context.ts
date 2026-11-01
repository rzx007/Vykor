import type { SessionUserInputItem } from "@shared/session-types"
import {
  readUtilityPanelRuntimeState,
  readUtilityPanelViewStates,
} from "@renderer/components/desktop/layout/main-layout/utility-panel/utility-panel-repository"

const contextStart = "\n\n<browser_annotations>\n"
const contextEnd = "\n</browser_annotations>"

function normalizePageUrl(value: string): string {
  try {
    return new URL(value).href
  } catch {
    return value.trim()
  }
}

function currentBrowserPage(scopeId: string): { tabId: string; url: string } | null {
  if (!readUtilityPanelViewStates()[scopeId]?.open) return null
  const state = readUtilityPanelRuntimeState(scopeId)
  const activeTab = state?.tabs.find(tab => tab.id === state.activeTabId)
  if (activeTab?.tool !== "browser") return null
  const browser = state!.browserTabs.find(tab => tab.id === activeTab.id)
  return browser?.url?.trim() && !browser.loading ? { tabId: browser.id, url: browser.url } : null
}

export function captureBrowserAnnotationContext(scopeId: string): Promise<string | null> | null {
  const page = currentBrowserPage(scopeId)
  if (!page) return null
  const isCurrent = (): boolean => {
    const current = currentBrowserPage(scopeId)
    return current?.tabId === page.tabId && normalizePageUrl(current.url) === normalizePageUrl(page.url)
  }
  return (async () => {
    try {
      const snapshot = await window.desktop.browser.readAnnotations({ tabId: page.tabId })
      if (!isCurrent() || !snapshot.ready || normalizePageUrl(snapshot.pageUrl) !== normalizePageUrl(page.url)) return null
      const annotations = snapshot.annotations.map(({ record: { target, selector, comment } }) => ({ target, selector, comment }))
      if (!annotations.length) return null
      return contextStart + JSON.stringify({ url: page.url, annotations }, null, 2).replaceAll("<", "\\u003c") + contextEnd
    } catch {
      if (!isCurrent()) return null
      throw new Error("读取当前页面批注失败，请重试后再发送")
    }
  })()
}

function trailingBrowserAnnotationContext(item: SessionUserInputItem | undefined): string | null {
  if (item?.type !== "text" || !item.text.endsWith(contextEnd)) return null
  const start = item.text.lastIndexOf(contextStart)
  if (start < 0) return null
  try {
    const data: unknown = JSON.parse(item.text.slice(start + contextStart.length, -contextEnd.length))
    if (!data || typeof data !== "object" || !("url" in data) || typeof data.url !== "string" ||
      !("annotations" in data) || !Array.isArray(data.annotations)) return null
  } catch {
    return null
  }
  return item.text.slice(start)
}

export function stripBrowserAnnotationContext(
  items: readonly SessionUserInputItem[],
  sourceItems?: readonly SessionUserInputItem[]
): SessionUserInputItem[] {
  const result = [...items]
  const sourceContext = trailingBrowserAnnotationContext(sourceItems?.at(-1))
  if (sourceContext) {
    for (let index = result.length - 1; index >= 0; index--) {
      const item = result[index]!
      if (item.type !== "text") continue
      const start = item.text.lastIndexOf(sourceContext)
      if (start < 0) continue
      const text = item.text.slice(0, start) + item.text.slice(start + sourceContext.length)
      if (text) result[index] = { ...item, text }
      else result.splice(index, 1)
      return result
    }
    return result
  }
  const last = result.at(-1)
  const context = trailingBrowserAnnotationContext(last)
  if (last?.type !== "text" || !context) return result
  const text = last.text.slice(0, -context.length)
  if (text) result[result.length - 1] = { ...last, text }
  else result.pop()
  return result
}

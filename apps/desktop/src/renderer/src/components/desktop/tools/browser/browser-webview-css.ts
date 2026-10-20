type WebviewCssHost = {
  insertCSS?: (css: string) => Promise<string>
}

export function insertWebviewCssWhenReady(
  webview: WebviewCssHost | null,
  css: string,
  ready: boolean
): void {
  if (!webview || !ready) return
  try {
    void webview.insertCSS?.(css).catch(() => undefined)
  } catch {
    // Electron throws synchronously if insertCSS runs before dom-ready.
  }
}

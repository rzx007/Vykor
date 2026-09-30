import type { WebContents } from "electron"

export type InspectedPage = {
  url: string
  title: string
  pageText: string
  elements: Array<{
    index: number
    selector: string
    role: string
    name: string
    href: string
    value: string
    requiresConfirmation: boolean
  }>
}

const MAX_PAGE_TEXT = 12_000
const MAX_ELEMENTS = 80
export const ELEMENT_INSPECT_SCRIPT = `(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || [...(el.labels || [])].map((label) => label.innerText).join(' ') || el.innerText || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ').slice(0, 180);
  const role = (el) => el.getAttribute('role') || ({ BUTTON: 'button', A: 'link', INPUT: el.type === 'checkbox' ? 'checkbox' : 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox' }[el.tagName] || 'control');
  const selector = (el) => {
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      let part = el.tagName.toLowerCase();
      if (el.id) { parts.unshift(part + '#' + CSS.escape(el.id)); break; }
      const siblings = el.parentElement ? [...el.parentElement.children].filter((item) => item.tagName === el.tagName) : [];
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')';
      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join('>');
  };
  const elements = [...document.querySelectorAll('button,a[href],input,textarea,select,[role=button],[role=link],[role=textbox],[contenteditable=true]')].filter(visible).slice(0, ${MAX_ELEMENTS});
  return {
    url: location.href,
    title: document.title,
    pageText: (document.body?.innerText || '').slice(0, ${MAX_PAGE_TEXT}),
    elements: elements.map((el, index) => {
      const label = name(el);
      const roleName = role(el);
      const formSubmit = Boolean(el.form) && el.matches('button:not([type=button]),input[type=submit]');
      const sensitive = /\\b(pay|purchase|buy|delete|remove|submit|send|post|confirm|place order|checkout|save changes)\\b|付款|购买|删除|提交|发送|发布|确认|下单|结账|保存/i.test(label);
      const sensitiveField = (el instanceof HTMLInputElement && /^(password|hidden|file)$/i.test(el.type)) || /password|secret|token|auth|card|cvv|cvc/i.test([el.name, el.id, el.autocomplete].join(' '));
      const value = 'value' in el ? (sensitiveField ? '[redacted]' : String(el.value).slice(0, 300)) : '';
      return { index, selector: selector(el), role: roleName, name: label, href: el instanceof HTMLAnchorElement ? el.href : '', value, requiresConfirmation: formSubmit || sensitive || sensitiveField };
    })
  };
})()`

export async function waitForPageUpdate(contents: WebContents, before: string): Promise<void> {
  const startedAt = Date.now()
  let lastFingerprint = before
  let changedAt: number | null = null
  while (Date.now() - startedAt < 2_500) {
    await new Promise((resolve) => setTimeout(resolve, 80))
    if (contents.isDestroyed()) return
    if (contents.isLoading()) continue

    let page: InspectedPage
    try {
      page = (await contents.executeJavaScript(ELEMENT_INSPECT_SCRIPT)) as InspectedPage
    } catch {
      // Navigation can replace the execution context between load events.
      continue
    }

    const currentFingerprint = fingerprintPage(page)
    const now = Date.now()
    if (currentFingerprint !== lastFingerprint) {
      lastFingerprint = currentFingerprint
      changedAt = now
    }
    if (changedAt !== null && now - changedAt >= 180) return
    if (changedAt === null && now - startedAt >= 900) return
  }
}

export function fingerprintPage(page: InspectedPage): string {
  return JSON.stringify({
    url: page.url,
    title: page.title,
    pageText: page.pageText,
    elements: page.elements.map(({ role, name, href, value }) => ({ role, name, href, value })),
  })
}

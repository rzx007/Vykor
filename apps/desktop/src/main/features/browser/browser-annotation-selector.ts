import { finder } from "@medv/finder"
import type { AnnotationTarget } from "../../../shared/browser-annotation"

const ATTRIBUTES = new Set(["data-testid", "data-test-id", "data-qa", "data-cy"])
const IDENTIFIER = /^[\p{L}\p{N}_.:-]{1,128}$/u
const GENERATED = /^(?::|_?r\d|react-aria|radix-|headlessui-|css-)|[a-f\d]{8,}/i

function stableId(value: string): boolean {
  return IDENTIFIER.test(value) && !GENERATED.test(value)
}

export function annotationSelector(
  element: Element
): Pick<AnnotationTarget, "selector" | "locatorKind"> | null {
  if (!element.isConnected || element === document.body || element === document.documentElement)
    return null
  const id = element.getAttribute("id")
  if (id && stableId(id)) {
    const selector = `#${CSS.escape(id)}`
    if (document.querySelectorAll(selector).length === 1)
      return { selector, locatorKind: "unique-id" }
  }

  // 限制候选类名和祖先深度，避免不可信页面制造过大的组合搜索。
  const classes = new Set<string>()
  let current: Element | null = element,
    depth = 0
  while (current && current !== document.documentElement) {
    if (++depth > 12) return null
    for (let i = 0; i < Math.min(current.classList.length, 16) && classes.size < 4; i++) {
      const value = current.classList[i]
      if (/^[a-z][a-z-]{2,80}$/i.test(value) && !GENERATED.test(value)) classes.add(value)
    }
    current = current.parentElement
  }
  try {
    const selector = finder(element, {
      root: document.body,
      idName: stableId,
      className: (value) => classes.has(value),
      attr: (name, value) => ATTRIBUTES.has(name) && IDENTIFIER.test(value),
      timeoutMs: 50,
      maxNumberOfPathChecks: 1000,
    })
    const matches = document.querySelectorAll(selector)
    if (selector.length > 512 || matches.length !== 1 || matches[0] !== element) return null
    // 位置下标仍是不可靠的重载锚点；语义属性/类名也必须在恢复时核对特征。
    const semantic =
      !/:nth-(?:child|of-type)\(/.test(selector) &&
      ["#", ".", "["].some((part) => selector.includes(part))
    return { selector, locatorKind: semantic ? "semantic" : "path" }
  } catch {
    return null
  }
}

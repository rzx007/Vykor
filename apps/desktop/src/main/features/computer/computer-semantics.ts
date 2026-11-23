import { createHash, randomUUID } from "node:crypto"
import type { ComputerSemanticAction } from "@vykor/server/daemon-host"
import type { WindowsDriverElement, WindowsDriverObservation } from "./windows-driver"

type ElementFacts = Omit<WindowsDriverElement, "token">

export interface ComputerObservation {
  windowRef: string
  digest: string
  focusIdentity?: string
  elements: Map<string, ElementFacts>
  display: {
    elements: Array<{
      ref: string
      role: string
      label: string
      depth?: number
      value?: string
      valueTruncated?: boolean
      selected?: boolean
      checked?: boolean
      expanded?: boolean
      scrollPosition?: { horizontal?: number; vertical?: number }
      actions: string[]
    }>
    limited: boolean
  }
}

const privateField = /password|passcode|credential|recovery (?:phrase|key|code)|one.time code|otp code|密码|口令|验证码|助记词|恢复(?:码|密钥)/iu
// Leave room for the result envelope within the Core tool output's 16,000-character default.
const maxObservationBytes = 12 * 1024

function publicLabel(label: string): string {
  return label.replace(/\p{Cc}/gu, "").slice(0, 240)
}

function controlType(role: string): string {
  return role.replace(/[\s_-]+/gu, "").toLowerCase()
}

function eligible(element: ElementFacts): boolean {
  return !element.protected && !privateField.test(element.label) && !privateField.test(element.role)
}

function offeredActions(element: ElementFacts): string[] {
  if (element.enabled === false || !eligible(element)) return []
  const actions = element.actions
  const result: string[] = []
  if (actions.includes("invoke") || actions.includes("expand")) result.push("invoke")
  if (actions.includes("select") || actions.includes("toggle")) result.push("choose")
  if (actions.includes("set_value") && /^(edit|document|combobox)$/u.test(controlType(element.role))) result.push("set_text")
  if (actions.includes("scroll")) result.push("scroll")
  return result
}

export function observationDigest(state: WindowsDriverObservation): string {
  return createHash("sha256").update(JSON.stringify(state.elements.filter(eligible).map(element => [
    element.identity, element.index, element.parentIndex, element.depth, element.role, element.label,
    element.value, element.valueDigest, element.valueTruncated, element.enabled, element.actions, element.selected, element.checked, element.expanded,
    element.horizontalScrollPercent, element.verticalScrollPercent,
  ]))).digest("hex")
}

export function projectObservation(windowRef: string, state: WindowsDriverObservation): ComputerObservation {
  const elements = new Map<string, ElementFacts>()
  const display: ComputerObservation["display"] = { elements: [], limited: false }
  const candidates: Array<{
    element: ElementFacts
    row: ComputerObservation["display"]["elements"][number]
    priority: number
  }> = []
  for (const { token: _token, ...element } of state.elements) {
    if (!eligible(element)) continue
    const ref = `element_${randomUUID()}`
    const row = {
      ref, role: publicLabel(element.role), label: publicLabel(element.label), depth: element.depth,
      value: element.value?.slice(0, 4000), valueTruncated: element.valueTruncated || (element.value?.length ?? 0) > 4000 || undefined,
      selected: element.selected, checked: element.checked,
      expanded: element.expanded,
      scrollPosition: element.horizontalScrollPercent === undefined && element.verticalScrollPercent === undefined ? undefined : {
        horizontal: element.horizontalScrollPercent, vertical: element.verticalScrollPercent,
      },
      actions: offeredActions(element),
    }
    // Keep current values and usable controls within the same budget on dense windows.
    const hasState = Boolean(row.value) || row.selected === true || row.checked !== undefined
    candidates.push({ element, row, priority: hasState ? 0 : row.actions.length ? 1 : 2 })
  }
  let bytes = 0
  for (const { element, row } of candidates.toSorted((left, right) => left.priority - right.priority)) {
    const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1
    if (bytes + size > maxObservationBytes || elements.size >= 120) {
      display.limited = true
      continue
    }
    bytes += size
    elements.set(row.ref, element)
  }
  display.elements = candidates.flatMap(({ row }) => elements.has(row.ref) ? [row] : [])
  return { windowRef, digest: observationDigest(state), focusIdentity: state.focusIdentity, elements, display }
}

export function supportsAction(element: ElementFacts, action: ComputerSemanticAction): boolean {
  return offeredActions(element).includes(action.type)
}

export function findControl(expected: ElementFacts, state: WindowsDriverObservation): WindowsDriverElement | undefined {
  const matching = state.elements.filter(element => eligible(element)
    && element.role === expected.role && element.label === expected.label
    && (expected.identity ? element.identity === expected.identity
      : element.depth === expected.depth && element.parentIndex === expected.parentIndex))
  return matching.length === 1 ? matching[0] : undefined
}

function normalizedText(text: string): string {
  return text.replace(/\r\n?/gu, "\n")
}

export function alreadySatisfied(action: ComputerSemanticAction, control: ElementFacts): boolean {
  if (action.type === "set_text") {
    return control.value !== undefined && !control.valueTruncated && normalizedText(control.value) === normalizedText(action.text)
  }
  return action.type === "choose" && (control.actions.includes("select") ? control.selected : control.checked) === true
}

export function needsApproval(action: ComputerSemanticAction, control: ElementFacts, notepad: boolean): boolean {
  if (action.type === "scroll") return false
  if (!notepad) return true
  const label = control.label.replaceAll("&", "").trim().toLowerCase()
  const role = controlType(control.role)
  if (action.type === "set_text" && role === "document" && /^(?:text editor|文本编辑器)$/iu.test(label)) {
    return control.value === undefined || control.valueTruncated === true || !normalizedText(action.text).includes(normalizedText(control.value))
  }
  return !(action.type === "invoke" && role === "menuitem"
    && /^(?:file|edit|view|文件|编辑|查看|new window|新建窗口)$/iu.test(label))
}

export function approvalReason(app: string, title: string, action: ComputerSemanticAction, control: ElementFacts): string {
  const verb = { invoke: "触发", choose: "选择", set_text: "修改", scroll: "滚动" }[action.type]
  return `允许在「${publicLabel(app)}」的「${publicLabel(title)}」窗口${verb}「${publicLabel(control.label)}」吗？该操作可能改变应用状态。`.slice(0, 290)
}

export function verifiedEffect(
  action: ComputerSemanticAction,
  control: ElementFacts,
  before: WindowsDriverObservation,
  after: WindowsDriverObservation,
): "field_value" | "selection" | "scroll_position" | "controls_changed" | undefined {
  const updated = findControl(control, after)
  switch (action.type) {
    case "set_text": return updated && alreadySatisfied(action, updated) ? "field_value" : undefined
    case "choose": return updated && alreadySatisfied(action, updated) ? "selection" : undefined
    case "scroll": {
      const horizontal = action.direction === "left" || action.direction === "right"
      const original = horizontal ? control.horizontalScrollPercent : control.verticalScrollPercent
      const current = horizontal ? updated?.horizontalScrollPercent : updated?.verticalScrollPercent
      const forward = action.direction === "down" || action.direction === "right"
      return original !== undefined && current !== undefined && (forward ? current > original : current < original)
        ? "scroll_position" : undefined
    }
    case "invoke": return observationDigest(before) !== observationDigest(after) ? "controls_changed" : undefined
  }
}

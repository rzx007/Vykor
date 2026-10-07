// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { DiagnosticReport, DiagnosisRequest } from "@shared/maintenance-settings-types"
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
import { DiagnosticsSettings } from "./diagnostics-settings"

let container: HTMLDivElement, root: Root
let report: DiagnosticReport
const diagnose = vi.fn(async (_input?: DiagnosisRequest) => report)
const cancelDiagnosis = vi.fn(async (_input?: DiagnosisRequest) => {})
const exportDiagnostics = vi.fn(async () => null as string | null)
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  report = {
    checkedAt: 1,
    desktopVersion: "1",
    platform: "win32",
    architecture: "x64",
    target: null,
    checks: [{ id: "health", name: "后台服务", status: "cancelled", detail: "已取消检查" }],
    logs: [],
    missing: ["当前服务运行日志"],
  }
  diagnose.mockReset().mockImplementation(async () => report)
  cancelDiagnosis.mockClear()
  exportDiagnostics.mockReset().mockResolvedValue(null)
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      maintenance: {
        diagnose,
        cancelDiagnosis,
        exportDiagnostics,
        diagnosticDetails: async () => ({ expiresAt: null }),
      },
    },
  })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
it("scopes cleanup to its own diagnosis even with StrictMode remounting", async () => {
  await act(async () =>
    root.render(
      <StrictMode>
        <DiagnosticsSettings />
      </StrictMode>
    )
  )
  expect(diagnose.mock.calls[0]).toEqual([
    expect.objectContaining({ requestId: expect.any(String) }),
  ])
  expect(cancelDiagnosis).toHaveBeenCalledWith(diagnose.mock.calls[0]?.[0])
  expect(diagnose.mock.calls[1]?.[0]).not.toEqual(diagnose.mock.calls[0]?.[0])
})
it("shows incomplete checks as unconfirmed rather than healthy", async () => {
  await act(async () => root.render(<DiagnosticsSettings />))
  expect(container.textContent).toContain("检查未完成，状态尚未确认")
  expect(container.textContent).not.toContain("本次服务检查通过")
  expect(container.textContent).toContain("日志未读取成功")
})
it("does not offer a diagnosis cancel action while exporting", async () => {
  let finish!: (value: null) => void
  exportDiagnostics.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await act(async () => root.render(<DiagnosticsSettings />))
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((item) => item.textContent === "导出诊断包")!
      .click()
  )
  expect(
    [...container.querySelectorAll("button")].some((item) => item.textContent === "取消检查")
  ).toBe(false)
  await act(async () => finish(null))
})

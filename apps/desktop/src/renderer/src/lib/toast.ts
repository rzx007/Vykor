import type { ReactNode } from "react"

import type { ToastInput, ToastStatus } from "@renderer/components/motion/animated-toast-stack"

export interface ToastDispatcher {
  showToast: (input: ToastInput) => string
  updateToast: (id: string, patch: Partial<ToastInput>) => void
  dismissToast: (id: string) => void
}

let dispatcher: ToastDispatcher | null = null

export function setToastDispatcher(next: ToastDispatcher | null): void {
  dispatcher = next
}

function push(status: ToastStatus, title: ReactNode, description?: ReactNode): string {
  if (!dispatcher) return ""
  return dispatcher.showToast(description ? { status, title, description } : { status, title })
}

export const toast = {
  show: (input: ToastInput): string => dispatcher?.showToast(input) ?? "",
  success: (title: ReactNode, description?: ReactNode): string =>
    push("success", title, description),
  error: (title: ReactNode, description?: ReactNode): string => push("error", title, description),
  info: (title: ReactNode, description?: ReactNode): string => push("info", title, description),
  loading: (title: ReactNode, description?: ReactNode): string =>
    push("loading", title, description),
  update: (id: string, patch: Partial<ToastInput>): void => dispatcher?.updateToast(id, patch),
  dismiss: (id: string): void => dispatcher?.dismissToast(id),
}

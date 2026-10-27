import {
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react"

import { useCodePreviewDrafts } from "@renderer/components/desktop/tools/editor/code-preview-drafts"
import { saveCodePreviewDraft } from "@renderer/components/desktop/tools/editor/code-preview-save"
import type { FileViewerTab } from "@renderer/components/desktop/tools/files/file-viewer"
import { destroySideChat } from "@renderer/components/desktop/tools/side-chat/side-chat-panel"
import type { PluginAppPageManager } from "@renderer/components/desktop/shell/plugin-apps/page-manager"
import type { UtilityTab } from "./utility-panel-tabs"
import type { CloseOrdinaryTabsAction } from "./use-utility-panel-runtime"
import type { UtilityPanelRuntimeState } from "./utility-panel-state"

type ClosePhase = "files" | "side-chat" | "apps"
type CloseInstance = {
  scopeId: string
  activeSessionId: string | null
  selectedProjectPath?: string
  valid: boolean
}
type CloseRequest = {
  tabIds: string[]
  preferredActiveTabId?: string
  phase: ClosePhase
  error: string | null
  busy: boolean
  instance: CloseInstance
  fileDecision?: "save" | "discard"
  sideChatDestroyed?: boolean
}
type CloseOptions = {
  scopeId: string
  activeSessionId: string | null
  selectedProjectPath?: string
  tabs: UtilityTab[]
  appTabIds: string[]
  pluginApps: PluginAppPageManager | null
  setFileTabs: Dispatch<SetStateAction<FileViewerTab[]>>
  closeOrdinaryTabs: (action: CloseOrdinaryTabsAction) => UtilityPanelRuntimeState
  persistFileTabs: (paths: string[], activePath: string | null) => void
  closeTerminals: (terminalIds: string[]) => void
}

/** 只协调一次界面关闭请求；页面和编辑内容仍由原有模块持有。 */
export function useUtilityPanelClose(options: CloseOptions) {
  const [instance, setInstance] = useState<CloseInstance>(() => ({
    scopeId: options.scopeId,
    activeSessionId: options.activeSessionId,
    selectedProjectPath: options.selectedProjectPath,
    valid: true,
  }))
  const [request, setRequest] = useState<CloseRequest | null>(null)
  const current = useRef<CloseRequest | null>(null)
  const latest = useRef(options)
  useLayoutEffect(() => {
    latest.current = options
  })
  useLayoutEffect(() => {
    instance.valid = true
    return () => {
      instance.valid = false
    }
  }, [instance])
  if (
    instance.scopeId !== options.scopeId ||
    instance.activeSessionId !== options.activeSessionId ||
    instance.selectedProjectPath !== options.selectedProjectPath
  ) {
    instance.valid = false
    current.current = null
    setRequest(null)
    setInstance({
      scopeId: options.scopeId,
      activeSessionId: options.activeSessionId,
      selectedProjectPath: options.selectedProjectPath,
      valid: true,
    })
  }
  const isCurrent = (value: CloseRequest) => value.instance.valid && current.current === value
  const update = (value: CloseRequest) => {
    if (isCurrent(value)) setRequest({ ...value })
  }
  const cancel = () => {
    if (current.current?.busy) return
    current.current = null
    setRequest(null)
  }
  const draftKey = (tab: UtilityTab, owner: CloseInstance) =>
    JSON.stringify([owner.scopeId, tab.projectPath, tab.filePath])
  // 除非明确选择不保存，否则在批次推进和最终提交前重新读取所有目标草稿。
  // 不保存沿用明确丢弃语义；这里只保存用户决定，不保存草稿内容。
  const needsFileConfirmation = (value: CloseRequest) => {
    if (value.fileDecision === "discard") return false
    const drafts = useCodePreviewDrafts.getState().drafts
    const closingDrafts = latest.current.tabs
      .filter((tab) => tab.filePath && value.tabIds.includes(tab.id))
      .map((tab) => drafts[draftKey(tab, value.instance)])
    const saving = closingDrafts.some((draft) => draft?.saving)
    const dirty = closingDrafts.some((draft) => draft && draft.content !== draft.originalContent)
    if (!saving && !dirty) return false
    value.phase = "files"
    value.busy = false
    value.error = saving ? "文件正在保存，请稍后重试。" : "仍有未保存的修改，请再次保存。"
    update(value)
    return true
  }
  const finishOrdinary = (value: CloseRequest) => {
    if (!isCurrent(value) || needsFileConfirmation(value)) return
    const api = latest.current
    const closing = api.tabs.filter((tab) => value.tabIds.includes(tab.id))
    const ordinaryIds = value.tabIds.filter((id) => !id.startsWith("plugin-app:"))
    if (ordinaryIds.length) {
      for (const tab of closing) {
        if (tab.filePath) useCodePreviewDrafts.getState().discard(draftKey(tab, value.instance))
      }
      const next = api.closeOrdinaryTabs({
        type: "closeOrdinaryTabs",
        tabIds: ordinaryIds,
        preferredActiveTabId: value.preferredActiveTabId,
        selectedProjectPath: value.instance.selectedProjectPath,
        appTabIds: api.appTabIds,
      })
      if (closing.some((tab) => tab.filePath)) {
        const files = next.fileTabs.filter(
          (file) => file.projectPath === value.instance.selectedProjectPath &&
            file.preview.scope !== "extra-root"
        )
        api.persistFileTabs(
          files.map((file) => file.preview.path),
          files.some((file) => file.preview.path === next.activeFilePath) ? next.activeFilePath : null
        )
      }
      const terminalIds = closing.map((tab) => tab.terminalId).filter((id): id is string => !!id)
      if (terminalIds.length) api.closeTerminals(terminalIds)
    }
    // 普通关闭只提交一次；应用失败后只保留尚未关闭的应用 ID。
    value.tabIds = value.tabIds.filter(
      (id) => id.startsWith("plugin-app:") && api.appTabIds.includes(id)
    )
    if (value.tabIds.length) {
      value.phase = "apps"
      value.busy = false
      update(value)
    } else cancel()
  }
  const afterFiles = (value: CloseRequest) => {
    if (!isCurrent(value) || needsFileConfirmation(value)) return
    if (
      !value.sideChatDestroyed &&
      value.instance.activeSessionId &&
      latest.current.tabs.some((tab) => tab.tool === "side-chat" && value.tabIds.includes(tab.id))
    ) {
      value.phase = "side-chat"
      value.busy = false
      value.error = null
      update(value)
    } else finishOrdinary(value)
  }
  const closeTabs = (tabIds: string[], preferredActiveTabId?: string) => {
    if (current.current || !instance.valid || !tabIds.length) return
    const value: CloseRequest = {
      tabIds: [...new Set(tabIds)],
      preferredActiveTabId,
      phase: "files",
      error: null,
      busy: false,
      instance,
    }
    current.current = value
    const drafts = useCodePreviewDrafts.getState().drafts
    const hasDirtyFiles = latest.current.tabs.some((tab) => {
      const draft = tab.filePath && value.tabIds.includes(tab.id)
        ? drafts[draftKey(tab, instance)] : null
      return draft && (draft.saving || draft.content !== draft.originalContent)
    })
    if (hasDirtyFiles) update(value)
    else afterFiles(value)
  }
  const confirmFiles = async (save: boolean) => {
    const value = current.current
    if (!value || value.phase !== "files" || value.busy || !isCurrent(value)) return
    value.fileDecision = save ? "save" : "discard"
    value.busy = true
    value.error = null
    update(value)
    try {
      const closingIds = value.tabIds
      for (const id of closingIds) {
        if (!isCurrent(value)) return
        const tab = latest.current.tabs.find((tab) => tab.id === id && tab.filePath)
        if (!tab) continue
        const key = draftKey(tab, value.instance)
        if (useCodePreviewDrafts.getState().drafts[key]?.saving)
          throw new Error("文件正在保存，请稍后重试。")
        if (save) {
          if (!tab.projectPath) throw new Error("找不到文件所在的项目，草稿仍已保留。")
          const result = await saveCodePreviewDraft(key, tab.projectPath, tab.filePath!)
          if (!isCurrent(value)) return
          if (result) {
            latest.current.setFileTabs((files) => files.map((file) =>
              file.projectPath === tab.projectPath && file.preview.path === tab.filePath
                ? { ...file, preview: result } : file
            ))
          }
          const draft = useCodePreviewDrafts.getState().drafts[key]
          if (draft && draft.content !== draft.originalContent)
            throw new Error("仍有未保存的修改，请再次保存。")
        }
      }
      value.busy = false
      afterFiles(value)
    } catch (error) {
      if (isCurrent(value)) {
        value.error = error instanceof Error ? error.message : String(error)
        value.busy = false
        update(value)
      }
    }
  }
  const confirmSideChat = async () => {
    const value = current.current
    if (!value || value.phase !== "side-chat" || value.busy || !isCurrent(value)) return
    if (needsFileConfirmation(value)) return
    value.busy = true
    value.error = null
    update(value)
    try {
      await destroySideChat(value.instance.activeSessionId!)
      if (!isCurrent(value)) return
      value.sideChatDestroyed = true
      value.busy = false
      finishOrdinary(value)
    } catch (error) {
      if (isCurrent(value)) {
        value.busy = false
        value.error = error instanceof Error ? error.message : String(error)
        update(value)
      }
    }
  }
  const confirmApp = async () => {
    const value = current.current
    if (!value || value.phase !== "apps" || value.busy || !isCurrent(value)) return
    value.busy = true
    value.error = null
    update(value)
    try {
      const manager = latest.current.pluginApps
      if (!manager) throw new Error("应用不可用，请稍后重试。")
      await manager.remove(value.tabIds[0]!.slice("plugin-app:".length), true)
      if (!isCurrent(value)) return
      value.tabIds = value.tabIds.slice(1)
      value.busy = false
      if (value.tabIds.length) update(value)
      else cancel()
    } catch {
      if (isCurrent(value)) {
        value.busy = false
        value.error = "未能关闭应用，页面草稿已保留。请查看最新状态后重试。"
        update(value)
      }
    }
  }
  return {
    request,
    closeTabs,
    cancel,
    confirmFiles,
    confirmSideChat,
    confirmApp,
    isCurrentContext: () => instance.valid,
  }
}

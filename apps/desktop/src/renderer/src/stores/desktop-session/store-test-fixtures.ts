import type { DesktopBootstrapData, DesktopSessionView } from "@shared/session-types"

import { createInitialRuntimeState } from "./initial-state"
import { createEmptySessionRuntime } from "./operation-state"
import { useDesktopSessionStore } from "./store"
import type { DesktopSessionRuntime } from "./types"

export type TestProject = {
  id: string
  name: string
  path: string
  lastOpenedAt: number
  available: boolean
}

export type TestProjectDetails = {
  project: TestProject
  git: boolean
  branch: string | null
  branches: string[]
}

export const refreshedBootstrap: DesktopBootstrapData = {
  connected: true,
  projects: [],
  sessions: [],
  archivedSessions: [],
  models: [
    {
      id: "deepseek-chat",
      label: "DeepSeek Chat",
      provider: "DeepSeek",
      providerName: "deepseek",
    },
  ],
  defaultModel: "deepseek-chat",
  defaultProvider: "deepseek",
  defaultPermissionMode: "default",
  attachments: {
    daemonSupported: false,
    interactionEnabled: false,
    uploadModes: [],
    limits: null,
  },
  outsideProjectWorkspaceRoot: "C:\\Users\\tester\\Documents\\Vykor",
}

const initialState = useDesktopSessionStore.getState()

export function resetDesktopSessionStore(): void {
  useDesktopSessionStore.setState({ ...initialState, ...createInitialRuntimeState() }, true)
}

export function sessionRuntime(sessionId: string): DesktopSessionRuntime {
  return useDesktopSessionStore.getState().sessionRuntimes[sessionId] ?? createEmptySessionRuntime()
}

export function emptySessionView(sessionId: string, cursor = 0): DesktopSessionView {
  return {
    cursor,
    syncStatus: "connected",
    session: {
      id: sessionId,
      cwd: "D:\\repo",
      title: "test",
      model: "test-model",
      status: "idle",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    },
    inputs: [],
    messages: [],
    parts: [],
    runs: [],
    tasks: [],
    permissions: [],
  }
}

export function projectDetails(
  project: TestProject,
  branch: string | null = null
): TestProjectDetails {
  return {
    project,
    git: Boolean(branch),
    branch,
    branches: branch ? [branch] : [],
  }
}

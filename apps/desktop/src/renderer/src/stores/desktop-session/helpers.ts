import type {
  DesktopBootstrapData,
  DesktopPermissionMode,
  DesktopProject,
  DesktopSessionRecord,
  DesktopWorkspaceMode,
} from "@shared/session-types"

import type { DesktopSessionState } from "./types"

export function upsertProject(
  projects: DesktopProject[],
  project: DesktopProject
): DesktopProject[] {
  const existingIndex = projects.findIndex((item) => samePath(item.path, project.path))
  const nextProjects =
    existingIndex === -1
      ? [project, ...projects]
      : projects.map((item, index) => (index === existingIndex ? project : item))

  return nextProjects.sort((a, b) => {
    const aPinnedAt = a.pinnedAt ?? 0
    const bPinnedAt = b.pinnedAt ?? 0
    const pinGroupDifference = Number(Boolean(bPinnedAt)) - Number(Boolean(aPinnedAt))
    return pinGroupDifference || (aPinnedAt && bPinnedAt ? bPinnedAt - aPinnedAt : 0)
  })
}

export function upsertSession(
  sessions: DesktopSessionRecord[],
  session: DesktopSessionRecord
): DesktopSessionRecord[] {
  return sortSessions([session, ...sessions.filter((item) => item.id !== session.id)])
}

export function sortSessions(sessions: DesktopSessionRecord[]): DesktopSessionRecord[] {
  return [...sessions].sort((a, b) => {
    const pinDifference = sessionPinnedAt(b) - sessionPinnedAt(a)
    return pinDifference || b.updatedAt - a.updatedAt
  })
}

export function isSessionPinned(session: DesktopSessionRecord): boolean {
  return sessionPinnedAt(session) > 0
}

export function resolveInitialProject(
  data: DesktopBootstrapData,
  current: DesktopProject | null,
  workspaceMode: DesktopWorkspaceMode
): DesktopProject | null {
  if (workspaceMode === "outside_project") return null
  if (current) {
    const match = data.projects.find((project) => samePath(project.path, current.path))
    if (match) return match
  }
  return data.projects[0] ?? null
}

export function resolveSessionWorkspace(
  projects: DesktopProject[],
  session: DesktopSessionRecord
): Pick<
  DesktopSessionState,
  | "workspaceMode"
  | "selectedProject"
  | "selectedProjectGit"
  | "selectedProjectGitCheckedAt"
  | "branch"
  | "branches"
> {
  if (session.workspaceMode === "outside_project" || !session.projectId) {
    return {
      workspaceMode: "outside_project",
      selectedProject: null,
      selectedProjectGit: false,
      selectedProjectGitCheckedAt: null,
      branch: null,
      branches: [],
    }
  }
  const project =
    projects.find((item) => item.id === session.projectId) ??
    projects.find((item) => samePath(item.path, session.cwd)) ??
    projectFromSession(session)
  return {
    workspaceMode: "project",
    selectedProject: project,
    selectedProjectGit: false,
    selectedProjectGitCheckedAt: null,
    branch: null,
    branches: [],
  }
}

export function sessionPermissionMode(
  session: DesktopSessionRecord,
  fallback: DesktopPermissionMode = "default"
): DesktopPermissionMode {
  const runtime = session.metadata["runtime"]
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return fallback
  const mode = (runtime as Record<string, unknown>)["permissionMode"]
  return mode === "default" || mode === "plan" || mode === "full_auto" ? mode : fallback
}

export function sessionEffort(session: DesktopSessionRecord): string | null {
  const runtime = session.metadata["runtime"]
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return null
  const effort = (runtime as Record<string, unknown>)["effort"]
  return typeof effort === "string" && effort.trim() ? effort.trim() : null
}

export function sessionProvider(
  session: DesktopSessionRecord,
  fallback: string | null = null
): string | null {
  const runtime = session.metadata["runtime"]
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return fallback
  const provider = (runtime as Record<string, unknown>)["provider"]
  return typeof provider === "string" && provider.trim() ? provider.trim() : fallback
}

export function projectFromSession(session: DesktopSessionRecord): DesktopProject {
  const normalized = session.cwd.replace(/[\\/]+$/, "")
  return {
    id: session.projectId ?? session.cwd,
    name: normalized.split(/[\\/]/).pop() || session.cwd,
    path: session.cwd,
    lastOpenedAt: session.updatedAt,
    ...(typeof session.metadata["defaultShell"] === "string"
      ? { defaultShell: session.metadata["defaultShell"] }
      : {}),
    available: true,
  }
}

/** 项目外起始页在创建会话前使用的占位工作区，供 slash 命令和右侧面板解析 cwd。 */
export function outsideProjectDraftWorkspace(root: string): DesktopProject {
  const normalized = root.replace(/[\\/]+$/, "")
  return {
    id: "outside-project-draft",
    name: normalized.split(/[\\/]/).pop() || "OpenHarness",
    path: root,
    lastOpenedAt: 0,
    available: true,
  }
}

export function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right)
}

export function formatSessionTitle(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim()
  const firstSentence = normalized.match(/^.*?[。！？.!?]/)?.[0] ?? normalized
  return [...firstSentence].slice(0, 20).join("")
}

export function isPlaceholderTitle(title: string): boolean {
  const normalized = title.trim()
  return normalized === "" || normalized === "TUI"
}

function sessionPinnedAt(session: DesktopSessionRecord): number {
  const desktop = session.metadata["desktop"]
  if (!desktop || typeof desktop !== "object" || Array.isArray(desktop)) return 0
  const pinnedAt = (desktop as Record<string, unknown>)["pinnedAt"]
  return typeof pinnedAt === "number" ? pinnedAt : 0
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase()
}

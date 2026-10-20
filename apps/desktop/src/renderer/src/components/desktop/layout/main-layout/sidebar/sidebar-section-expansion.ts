export interface SidebarSectionExpansion {
  projects: boolean
  im: boolean
  recent: boolean
}

export const SIDEBAR_SECTIONS_STORAGE_KEY = "vykor.desktop.sidebar-section-expansion"

export const DEFAULT_SIDEBAR_SECTION_EXPANSION: SidebarSectionExpansion = {
  projects: true,
  im: true,
  recent: true,
}

/**
 * 解析并校验存储的折叠展开状态，若数据损坏或缺失则安全回退到默认展开状态
 */
export function parseSidebarSectionExpansion(raw: string | null | undefined): SidebarSectionExpansion {
  if (!raw) {
    return { ...DEFAULT_SIDEBAR_SECTION_EXPANSION }
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== "object" || parsed === null) {
      return { ...DEFAULT_SIDEBAR_SECTION_EXPANSION }
    }
    const record = parsed as Partial<Record<keyof SidebarSectionExpansion, unknown>>
    return {
      projects:
        typeof record.projects === "boolean"
          ? record.projects
          : DEFAULT_SIDEBAR_SECTION_EXPANSION.projects,
      im:
        typeof record.im === "boolean" ? record.im : DEFAULT_SIDEBAR_SECTION_EXPANSION.im,
      recent:
        typeof record.recent === "boolean"
          ? record.recent
          : DEFAULT_SIDEBAR_SECTION_EXPANSION.recent,
    }
  } catch {
    return { ...DEFAULT_SIDEBAR_SECTION_EXPANSION }
  }
}

/**
 * 从浏览器的 localStorage 读取侧边栏栏目展开状态
 */
export function loadSidebarSectionExpansion(): SidebarSectionExpansion {
  try {
    return parseSidebarSectionExpansion(localStorage.getItem(SIDEBAR_SECTIONS_STORAGE_KEY))
  } catch {
    return { ...DEFAULT_SIDEBAR_SECTION_EXPANSION }
  }
}

/**
 * 将侧边栏栏目的展开收起状态保存到 localStorage
 */
export function saveSidebarSectionExpansion(state: SidebarSectionExpansion): void {
  try {
    localStorage.setItem(SIDEBAR_SECTIONS_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 属于不影响核心流程的辅助界面状态，异常时不阻断桌面应用运行
  }
}

import { createPanelWidthStore } from "../panel-width-store"

export { shouldPersistPanelWidth as shouldPersistSidebarWidth } from "../panel-width-store"

const sidebarWidthStore = createPanelWidthStore({
  storageKey: "vykor.desktop.workspace-sidebar-width-px",
  defaultPx: 288,
  minPx: 266,
  maxPx: 420,
})

export const SIDEBAR_DEFAULT_WIDTH_PX = sidebarWidthStore.defaultPx
export const SIDEBAR_MIN_WIDTH_PX = sidebarWidthStore.minPx
export const SIDEBAR_MAX_WIDTH_PX = sidebarWidthStore.maxPx

export const clampSidebarWidthPx = sidebarWidthStore.clamp
export const readStoredSidebarWidthPx = sidebarWidthStore.read
export const persistSidebarWidthPx = sidebarWidthStore.persist
export const resolveSidebarDefaultWidthPx = sidebarWidthStore.resolveDefault

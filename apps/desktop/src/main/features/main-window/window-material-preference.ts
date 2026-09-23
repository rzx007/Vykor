import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { app } from "electron"

import {
  DEFAULT_WINDOW_MATERIAL_PREFERENCE,
  isDesktopWindowMaterialPreference,
  type DesktopWindowMaterialPreference,
} from "../../../shared/window-material-types"

export const WINDOW_MATERIAL_PREFERENCE_FILE_NAME = "desktop-window-material.json"

/**
 * 材质偏好的持久化（唯一真相源，D3）。
 *
 * 主进程在建窗口时必须同步知道上次选了什么：走 renderer 的 localStorage 行不通（那时 renderer 还没起来），
 * 所以偏好落在 userData 下的一个小 JSON 文件里，模式对齐 `desktop-preferences-storage.ts`。
 * 刻意不做内存缓存：读盘只在建窗口与切换材质时发生（低频），少一层缓存就少一处「缓存与磁盘不一致」的状态；
 * 文件缺失、损坏或取值非法时一律回退默认值。
 */
export function resolveWindowMaterialPreferencePath(userDataDir: string): string {
  return join(userDataDir, WINDOW_MATERIAL_PREFERENCE_FILE_NAME)
}

export interface WindowMaterialPreferenceStore {
  get(): DesktopWindowMaterialPreference
  set(preference: DesktopWindowMaterialPreference): void
}

export function createWindowMaterialPreferenceStore(
  resolvePath: () => string
): WindowMaterialPreferenceStore {
  const get = (): DesktopWindowMaterialPreference => {
    try {
      const raw = JSON.parse(readFileSync(resolvePath(), "utf8")) as unknown
      return isDesktopWindowMaterialPreference(raw) ? raw : DEFAULT_WINDOW_MATERIAL_PREFERENCE
    } catch (error) {
      // 文件不存在是首次启动的正常情况，不告警；其它读取失败（权限、损坏）才需要留痕。
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.warn("[window-material] failed to read window material preference", error)
      }
      return DEFAULT_WINDOW_MATERIAL_PREFERENCE
    }
  }

  const set = (preference: DesktopWindowMaterialPreference): void => {
    try {
      writeFileSync(resolvePath(), JSON.stringify(preference), "utf8")
    } catch (error) {
      // 写盘失败只影响「重启后」的取值：本次会话的材质由调用方决定——
      // window.ts 会读回旧偏好，并把旧材质重新应用到窗口。
      console.warn("[window-material] failed to persist window material preference", error)
    }
  }

  return { get, set }
}

// 生产默认实例惰性创建：只有真正被调用时才触碰 electron 的 app，模块加载期不依赖它。
let defaultStore: WindowMaterialPreferenceStore | null = null

function resolveDefaultStore(): WindowMaterialPreferenceStore {
  if (!defaultStore) {
    defaultStore = createWindowMaterialPreferenceStore(() =>
      resolveWindowMaterialPreferencePath(app.getPath("userData"))
    )
  }
  return defaultStore
}

export function getWindowMaterialPreference(): DesktopWindowMaterialPreference {
  return resolveDefaultStore().get()
}

export function setWindowMaterialPreference(preference: DesktopWindowMaterialPreference): void {
  resolveDefaultStore().set(preference)
}

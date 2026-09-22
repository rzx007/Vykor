import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  createWindowMaterialPreferenceStore,
  resolveWindowMaterialPreferencePath,
  WINDOW_MATERIAL_PREFERENCE_FILE_NAME,
} from "./window-material-preference"

describe("createWindowMaterialPreferenceStore", () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wm-"))
    path = join(dir, WINDOW_MATERIAL_PREFERENCE_FILE_NAME)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("文件缺失时返回默认玻璃", () => {
    const store = createWindowMaterialPreferenceStore(() => path)
    expect(store.get()).toBe("glass")
  })

  it("写入后新实例能读回同一个偏好", () => {
    createWindowMaterialPreferenceStore(() => path).set("opaque")
    expect(createWindowMaterialPreferenceStore(() => path).get()).toBe("opaque")
  })

  it("损坏内容回退默认", () => {
    writeFileSync(path, "not-json", "utf8")
    expect(createWindowMaterialPreferenceStore(() => path).get()).toBe("glass")
  })

  it("非法取值回退默认", () => {
    writeFileSync(path, JSON.stringify("holographic"), "utf8")
    expect(createWindowMaterialPreferenceStore(() => path).get()).toBe("glass")
  })
})

describe("resolveWindowMaterialPreferencePath", () => {
  it("落在 userData 目录下", () => {
    expect(resolveWindowMaterialPreferencePath("/tmp/oh")).toBe(
      join("/tmp/oh", WINDOW_MATERIAL_PREFERENCE_FILE_NAME)
    )
  })
})

export interface DesktopTextMenuInput {
  editable: boolean
  hasSelection: boolean
}

/** 只读消息的动作回到 renderer；输入框由系统原生编辑角色处理。 */
export type DesktopTextMenuAction = "copy" | "select-all" | null

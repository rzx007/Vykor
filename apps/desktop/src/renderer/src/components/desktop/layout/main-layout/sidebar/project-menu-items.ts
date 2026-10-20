export function projectMenuItems(pinned: boolean): Array<{ id: string; label: string }> {
  return [
    { id: "pin", label: pinned ? "取消置顶项目" : "置顶项目" },
    { id: "reveal", label: "在资源管理器中打开" },
    { id: "rebind", label: "重新绑定目录" },
    { id: "rename", label: "重命名项目" },
    { id: "remove", label: "从列表移除" },
  ]
}

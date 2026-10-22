const permissionLabels: Record<string, string> = {
  filesystem: "文件访问",
  network: "网络访问",
  process: "运行程序",
  secrets: "密钥访问",
  tool: "工具权限",
  ui: "插件界面",
  pluginData: "插件自身数据",
}
const uiPermissionLabels: Record<string, string> = {
  "ui:render": "显示插件的隔离交互界面",
  "ui:invoke-own-tools": "请求插件自身工具，按工具授权确认",
  "pluginData:write": "允许已声明的应用专用工具自动保存插件自身数据；工作区导出仍单独确认",
}
export function groupPermissions(
  permissions: string[],
): Array<{ label: string; values: string[] }> {
  const groups = new Map<string, string[]>()
  for (const permission of permissions) {
    const prefix = permission.split(/[:/]/u, 1)[0]
    const label = permissionLabels[prefix] ?? "其他权限"
    const suffix =
      uiPermissionLabels[permission] ??
      (permission.slice(prefix.length).replace(/^[:/]/u, "") || permission)
    const values = groups.get(label) ?? []
    if (!values.includes(suffix)) values.push(suffix)
    groups.set(label, values)
  }
  return [...groups].map(([label, values]) => ({ label, values }))
}

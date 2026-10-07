import { settingsSectionLabel } from "./settings-navigation"

export interface SettingSearchResult { section: string; label: string; title: string; target?: string }
const entries: Array<[string, string, string, string?]> = [
  ["general", "默认模型", "供应商 默认 新对话 思考方式", "provider-defaults-heading"],
  ["general", "默认批准方式", "权限 手动 自动 只读计划", "general-permission-mode"],
  ["general", "系统通知", "提醒 完成 失败 焦点"],
  ["general", "界面主题", "浅色 深色 跟随系统"],
  ["general", "开发习惯", "默认 终端 Shell 本机 WSL 运行环境"],
  ["general", "任务轮数上限", "高级 maxTurns 推进 模型请求", "general-max-turns"],
  ["general", "浏览器开发者模式", "高级 页面诊断 DOM", "general-browser-developer"],
  ["general", "工作风格", "务实 高效 沟通"], ["general", "思考过程展示", "推理 展开 隐藏"],
  ["general", "后台持续运行", "daemon 自启动 常驻 登录 恢复"], ["general", "默认文件打开应用", "编辑器 文件 打开目标"],
  ["general", "完成后自动检查", "风险 只读审查 autoReview", "auto-review-mode"], ["general", "配置导入和导出", "备份 偏好 JSON", "configuration-transfer-heading"],
  ["providers", "默认模型", "供应商 默认 服务 模型 model 推理强度 effort"], ["providers", "模型连接与凭据", "API 密钥 认证 自定义服务 请求头 headers 连接测试"],
  ["permissions", "默认批准方式", "权限 自动批准 手动 计划 只读", "permission-mode"],
  ["permissions", "禁止工具", "deniedTools", "permissions-deniedTools"], ["permissions", "自动通过工具", "autoApproveTools", "permissions-autoApproveTools"],
  ["permissions", "工具允许列表", "白名单 allowedTools", "permissions-allowedTools"], ["permissions", "禁止命令", "命令黑名单", "permissions-deniedCommands"],
  ["permissions", "文件和网络边界", "隔离 sandbox SRT 允许读取 写入 域名", "permission-isolation-heading"],
  ["permissions", "浏览器开发者模式", "页面结构 DOM 控制台 网络诊断", "browser-developer-mode"], ["permissions", "已保存授权", "撤销 站点 工具批准", "permission-approvals-heading"],
  ["personalization", "自定义指令", "提示词 systemPrompt 项目规则"], ["personalization", "项目长期记忆", "memory 提取 会话连续性 整理 门槛 dream 删除 清空 搜索"],
  ["notifications", "系统通知", "任务完成 失败 需要处理 焦点 提醒 通知测试"], ["notifications", "通知音效", "声音 试听 静音"],
  ["appearance", "主题与颜色", "深色 浅色 跟随系统 强调 背景 前景 对比度"], ["appearance", "字体与字号", "界面字体 代码字体 恢复"],
  ["appearance", "窗口与动效", "磨玻璃 透明 减少动态"], ["keyboard", "键盘快捷键", "按键 绑定 搜索 冲突 清除 恢复 Esc"],
  ["terminal", "终端启动设置", "Shell PowerShell cmd Git Bash WSL 参数 变量 测试终端"], ["terminal", "终端显示", "字体 字号 滚动历史 scrollback 光标 闪烁"],
  ["terminal", "多行粘贴确认", "终端 复制 粘贴 安全"], ["git", "Git 检测与身份", "版本 路径 本机 WSL 提交 姓名 邮箱 来源"],
  ["git", "Git 差异偏好", "暂存 未提交 空白 split unified"], ["git", "独立工作目录", "worktree 分支前缀 创建 清理 成果"],
  ["runtime", "运行位置和发行版", "本机 WSL distribution 项目覆盖 继承", "runtime-kind"],
  ["runtime", "命令 Shell", "可执行文件 启动参数", "runtime-shell"], ["runtime", "任务环境变量", "env 机密 秘密 配置", "runtime-env-heading"],
  ["runtime", "环境检查与切换", "Git Node Python 检测 重启 生效状态"], ["billing", "用量统计", "Token 输入 输出 缓存 请求 模型 供应商 日期 未知 完整性"],
  ["billing", "费用与价格依据", "计费 账单 估算 订阅 币种 单价"], ["billing", "用量导出和预算提醒", "CSV JSON 金额 阈值"],
  ["storage", "空间与附件维护", "磁盘 占用 附件 扫描 修复 清理 数据目录"], ["storage", "备份和恢复", "校验 checksum 导入 数据切换"],
  ["storage", "历史数据保留", "会话 删除 日志 缓存 期限 清理审计"], ["diagnostics", "服务与环境诊断", "health 版本 协议 连接 MCP 认证 错误 重启 排障"],
  ["diagnostics", "日志与诊断导出", "trace 日志 详细诊断 脱敏 筛选 导出"], ["connections", "消息渠道", "飞书 连接 停用 移除 消息 用户 群聊 允许列表 ACL"],
]
export function searchSettings(query: string): SettingSearchResult[] {
  const words = query.normalize("NFKC").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  return entries.filter(([section, title, keywords]) => words.every(word => `${settingsSectionLabel(section)} ${title} ${keywords}`.toLocaleLowerCase().includes(word)))
    .map(([section, title, , target]) => ({ section, title, target, label: settingsSectionLabel(section) }))
}

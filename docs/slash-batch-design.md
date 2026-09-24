# 设计：E.2 高价值斜杠命令批次

> 状态：历史设计记录。`/stats` `/reload-plugins` `/subagents` `/plugin`，
> 这是当时的实现设计。当前命令目录和分发由 server/client command 模块负责；本文不作为现行入口说明。

## 命令清单

- **`/stats`** — 会话统计：messages（engine history 条数）、estimated_tokens
  （services `estimateTokens`）、tools（bundle toolRegistry 数）、memory 条目、
  后台任务数、当前 output_style。
- **`/reload-plugins`** — 重新发现并注册插件贡献。**先清后注册**：先注销
  `source === "plugin"` 的 skills 与 `plugin:` 前缀的 hooks，再
  installed store + Native Plugin activation，保证 disable 后 reload 真正下线
  （agents 由 wholesale 替换天然覆盖）。
- **`/subagents`** — 列出三源（builtin/user/plugin）agent 人格及 source/model。
- **`/plugin list|enable|disable NAME`** — 列插件（含贡献计数）；启停写入
  `settings.plugins`（`updateSettings` 持久化），提示用 `/reload-plugins` 生效。

## 顺带修复

- `getUserPluginsDir()` 尊重 `VYKOR_CONFIG_DIR`（与 core/paths 同约定，
  测试隔离需要）。
- core `HookExecutor` 接口补可选 `getAll()` / `unregister()`（hooks 包实现
  本就有，接口面跟上，供 reload 清理用）。

## 与 Python v0.1.9 差异

| 项 | Python | TS | 理由 |
|---|---|---|---|
| `/subagents` | 运行中子代理任务视图 | 三源人格定义列表 | 任务视图已由既有 `/agents` 覆盖 |
| `/stats` memory | memory_files 文件数 | MemoryManager 会话内条目数 | TS 记忆是会话内管理器（代码内注释标注） |
| `/plugin install/uninstall` | 有 | 不做 | 无插件市场，目录即安装 |
| `/reload-plugins` 清理 | 无显式清理 | 先清后注册 | enable/disable 立即生效不留幽灵贡献 |

## 测试

`apps/cli/src/commands/slash-batch.test.ts`：helpers + daemon profile/context 服务冒烟（旧 REPL registry 已拆除）
四命令输出形状 + `/plugin enable` 持久化断言；discovery.test 钉住
`VYKOR_CONFIG_DIR` 重定向。

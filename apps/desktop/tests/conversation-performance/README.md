# Electron 会话性能验证

使用隐藏的 Electron 窗口运行真实会话组件，不创建界面预览或截图。构建产物位于仓库的 `.superpowers/conversation-performance`，运行时使用独立临时用户目录。

## 文件与入口

- [electron.vite.config.ts](electron.vite.config.ts)：构建主进程、渲染页面和代码高亮 worker。
- [main.ts](main.ts)：启动 Chromium 指标采样，默认执行滚动、虚拟列表、代码连续性和面板交互检查。
- [renderer.tsx](renderer.tsx)、[panels.tsx](panels.tsx)：默认场景的组件和操作入口。
- [markdown.tsx](markdown.tsx)：通过实际 `AssistantMarkdown` 与外观设置运行长文本场景，保留产品现有刷新调度。
- [markdown-check.ts](markdown-check.ts)：采样 Markdown 更新期间的主线程指标，输出逐轮 JSON。
- [Streamdown 2.7 对比记录](streamdown-2.7-comparison.md)：本次升级的测量条件、结果和限制。
- [链接处理优化对比记录](streamdown-link-optimization-comparison.md)：内部属性过滤、通配符解析补丁的回归范围，以及局部校验和完整渲染的分别测量。

默认检查从仓库根目录运行：

```powershell
pnpm --filter @vykor/desktop test:conversation-performance
```

只测 Markdown 的 PowerShell 入口：

```powershell
$env:VYKOR_MARKDOWN_PERFORMANCE = "1"
pnpm --filter @vykor/desktop test:conversation-performance
Remove-Item Env:VYKOR_MARKDOWN_PERFORMANCE
```

每个场景先挂载并追加两次作为预热，再测八次更新；三个场景分别在动画开启、关闭时执行三轮。计时器、正文基线和外观状态随场景重新建立，输出同时记录依赖版本、Electron 与 Chromium 版本。退出时由运行脚本清理临时用户目录。

主线程耗时来自 Chromium `Performance.getMetrics` 的增量，其中 `TaskDuration` 包含主线程任务，`ScriptDuration`、`LayoutDuration` 和 `RecalcStyleDuration` 分别记录脚本、布局和样式计算。每轮还记录可见更新时间、超过 50ms 的任务数量、动画节点数、列表项数量和完成后的正文一致性。

新增用例应补充到现有场景，不修改产品解析、刷新或动画逻辑来配合基准。不能只用总运行时间判断性能：必须检查每次追加实际显示、Markdown 结构完整、动画开关有效，且完成时没有残留动画节点。

只验证向上翻历史时的高度补偿，以及停止跟随和返回最新的 PowerShell 入口：

```powershell
$env:VYKOR_HISTORY_SCROLL_PERFORMANCE = "1"
pnpm --filter @vykor/desktop test:conversation-performance
Remove-Item Env:VYKOR_HISTORY_SCROLL_PERFORMANCE
```

此场景在 1,000 和 10,000 行中模拟上滚，并让视口上方已测量的行增高 200px，记录实际 `scrollTop` 被反向修正的距离；正确结果为 0。随后检查历史阅读位置保持和恢复底部跟随。

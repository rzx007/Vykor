# Native Plugin UI A4 验证记录

> 状态：当前验证记录；以本页列出的实际命令和范围为准，不等同用户人工验收或正式发布。

## 范围

用户批准连续完成官方参考插件与作者指南，并明确取消转换诊断。现有 Codex / Claude Code 转换代码、权限和测试不改动；未来退役需要另行决定。实现位于 `codex/plugin-ui-a1` 的隔离工作区，基于 `acff63f0`，不合并、推送或发布，不修改用户主工作区。

参考插件使用已有 `example.text-inspector`，版本 1.1.0。普通检查文字仍为 `{findings,truncated}`；UI 是附加数据，大文本保留纯文字结果。新工具生成所选修复的文本预览，不写文件、操作剪贴板或自动调用模型。

## 已取得证据

- 真实 Native 子进程工具测试 19 项通过：普通文字兼容、UI 建议、选项验证、仅修复所选问题、LF/CRLF、输入上限与大文本回退。
- 真实安装与 Tool Host 测试 2 项通过：新增 UI 权限明确批准，源目录删除后快照仍可用，静态校验不执行工具。
- 插件生命周期 HTTP 回归 6 项通过：实际 link/install、reload、权限漂移、跨工作目录禁用/卸载和两个工具的清理。
- Desktop 卡片测试 9 项通过：含确认取消、源 Part 撤销和默认安全焦点检查。
- 实际 UI 单文件构建通过，24 个浏览器模块，无 Node 依赖；SDK 工具示例类型检查通过。
- Desktop Node / Web 类型检查通过。
- UI 设计检测仅跑一次，`panel.template.html` 和 `panel.mjs` 返回空问题列表。沿用现有桌面的中性色、系统正文、薄边框和原生控件；未更改 DESIGN.md 或新增视觉系统。

## 真实 Electron 样例验收

最终运行通过：Electron 39.8.10，退出码 0，额外引擎诊断 0。本次安装实际参考插件目录，使用原生 Desktop 主进程、preload、隔离协议、卡片/确认/SDK、Node Daemon、真实 SQLite 和会话通知。模型只用固定本地测试实现；没有外部 API、用户 daemon 或日常插件状态。

实际验证：

- Space 勾选问题，Tab 遍历问题和预览按钮，Enter 请求操作。
- 主界面默认焦点在“返回”；Enter 和 Escape 取消均不产生 UI Run。
- 确认后仅执行一次 `TextInspectorPreview`；输入仍为 1 条，模型 Attempt 数不变；新文本为 `"ok\n\titem\n"`，没有生成工作目录文件。
- 四种宽度/主题下无横向溢出；同一实例移到侧栏，关闭显示后焦点恢复“打开交互”，重新打开保留修复结果。
- 结束交互保存 `dismissed`；仍显示只读预览，操作禁用。之后关闭显示不会产生额外工具执行。
- Native 日志只有 `TextInspectorCheck` 和 `TextInspectorPreview` 两条执行审计；参数仅为类型/长度摘要，无 token、HTML、原文本、选项值或安装快照路径。原有 cwd 审计字段保留。

四张截图位于本阶段忽略目录 `.superpowers/sdd/2026-10-04-native-plugin-ui-a4/screenshots/`，分别为 `wide-light.png`、`narrow-light.png`、`wide-dark.png`、`narrow-dark.png`，已全部查看。一次独立限定审查给出 `disposition: ship（限定 A4）`；未审旧阶段或转换器，没有实质修复项。记录沿用现有 PRODUCT.md / DESIGN.md，没有重写设计系统。

开发中的失败已区分为构建限制、测试假定和窗口环境问题：单文件脚本不支持顶层 await；旧测试没有批准 UI 权限并假定只有一个工具；隐藏窗口不能可靠接收输入；确认按钮选择需要等待弹窗初始焦点；测试中的换行转义和审计字段顺序须与真实结果一致；结束交互是保留只读结果，不是自动移除页面。另有一次安装阶段启动超时和一次整体验收超时，单独后台探针与最终完整样例运行均通过；本记录不据此承诺跨平台或长期稳定性。

复现时先使用仓库已有依赖和已缓存的 Electron，再执行：

```powershell
node examples/plugins/text-inspector/scripts/build-ui.mjs
pnpm --config.manage-package-manager-versions=false --filter @vykor/desktop exec electron-vite build --config tests/plugin-ui-electron/electron.vite.config.ts
$env:VYKOR_UI_TEST_REFERENCE = 'only'
node apps/desktop/scripts/test-plugin-ui-electron.mjs
```

`only` 只运行新增参考插件验收，不重复 A3 攻击夹具；不设置时保留完整 Electron 回归入口。Windows 从未显示的窗口不能可靠接收跨 frame 原生焦点，因此独立验证窗口在屏幕外激活，键盘事件使用 Chromium 输入接口，不用 JS 伪造事件或直接点击来替代键盘断言。

最终针对性测试合计 36 项通过（Native 19 + 安装 2 + 生命周期 6 + 卡片 9）；不是整仓测试结果。文档检查通过 380 个 Markdown 文件。样例 HTML 重复构建摘要一致，工作区差异无空白错误。

## 发布边界

UI-24 的用户人工验收仍需用户在实际 Desktop 安装样例、走一遍确认/取消/侧栏。自动化与截图检查不能替代用户人工确认。本次平台为 Windows；macOS、Linux 和 Web 客户端不在本次证据内。CLI/TUI 继续使用普通文字，不承诺显示 UI。

A3 的隔离攻击、双窗口版本冲突和管理撤销证据保持原范围，见 [A3 验证记录](2026-10-03-native-plugin-ui-a3-verification.md)，不重复宣称为 A4 新测试。

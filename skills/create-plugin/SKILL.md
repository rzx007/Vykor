---
name: create-plugin
description: Use when creating, extending, or packaging a Vykor Native Plugin with Skills, Agents, Hooks, MCP servers, Native Tools, or interactive UI. 不用于改造 Vykor 本身，也不用于转换 Claude Code 或 Codex 插件。
---

# 开发 Vykor 插件

把用户需要的能力做成可单独安装的 Native Plugin。交付真实文件、验证结果和使用方法，不只是目录示意。此 Skill 独立分发，不要求用户拥有 Vykor 源码。

## 先决定交付什么

- 只有可复用的提示词或操作说明：一个普通 Skill 就够了；用户明确要求插件包时，再加 Native manifest。
- 需要调用可执行代码：添加 Native Tool 或接入真实 MCP 服务。
- 需要人选择、确认、预览结果：添加 UI，并由同插件 Native Tool 提供初始数据和后续操作。
- 需要自动监听事件：按用户要求添加 Hook，不把普通交互做成自动执行。

只声明用得上的组件。目的地已经明确时直接创建；否则在当前工作目录下选一个新目录。ID、外部服务、数据写入或权限存在关键歧义时才询问。不要覆盖已有目录，也不要修改已经安装的快照。

## 按需读取

所有相对路径都以本 Skill 目录为基准，不是以用户的工作目录为基准。

| 当前任务 | 需要读取的文件 |
| --- | --- |
| manifest、Skill、Agent、Hook、MCP、Node 工具 | [Native Plugin 接口](references/native-plugin.md) |
| 内联卡片、会话侧栏、确认按钮、结果预览 | 上一份接口说明和 [插件 UI](references/plugin-ui.md) |
| 校验、调试、安装说明、打包交付 | [验证与交付](references/verification.md) |

需要工具＋UI 的可运行起点时，复制 `assets/text-inspector/` 到用户的新插件目录，再按需求修改。这个样例只检查传入文本、生成所选修复预览，不写文件；没有示例 Skill 或 Agent 被偷偷注册。发布自己的插件前修改 manifest 的 ID、name、description、version，以及工具名称、UI action 的 tool 引用和业务文案。

## 实现流程

1. 写 `.vykor-plugin/plugin.json`，声明实际存在的组件及实际需要的权限。所有组件路径留在插件目录内。
2. 实现组件。Node 工具导出 `registerTools`，返回 `content` 内容块；参数、结果和错误都要有明确上限。UI 入口是提前构建的单文件 HTML。
3. UI 先读快照，再请求已声明的动作。业务执行由宿主确认和后台工具完成；界面不能直接访问文件、网络或任意工具。
4. 运行与组件对应的检查。`vk` 不存在时，仍可以做 Node 语法检查和纯逻辑测试；明确说明宿主校验、真实激活和桌面交互尚未验证。
5. 给出输出目录、功能、请求的权限、实际跑过的检查和安装后的入口。安装、link、替换、发布都不是“创建插件”的默认动作。

## 工具＋UI 样例的离线构建

复制样例之后，在新插件目录执行：

```sh
node scripts/build-ui.mjs
node --check tools/index.mjs
```

只需要 Node。`ui/sdk.js` 已包含浏览器 SDK，`ui/panel.mjs` 使用 `VykorPluginUi.createPluginUiClient()`；构建脚本把 SDK、界面代码、CSS 合到 `ui/panel.html`。修改源码后必须重新构建。

`@vykor/plugins/sdk` 是开发期类型入口，不是运行时 API；`@vykor/plugins/ui-sdk` 是仓库内的浏览器入口。不要假定这两个入口已发布为可下载的 npm 包。独立作者使用本目录附带的 SDK 和接口说明，不要手写宿主通信协议。

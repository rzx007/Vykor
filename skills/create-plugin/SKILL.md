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
| 内联卡片、会话侧栏、确认按钮、结果预览 | 上一份接口说明和 [插件 UI](references/plugin-apps.md) |
| 校验、调试、安装说明、打包交付 | [验证与交付](references/verification.md) |

需要工具＋UI 的可运行起点时，复制 `assets/text-inspector/` 到用户的新插件目录，再按需求修改。这个样例只检查传入文本、生成所选修复预览，不写文件；没有示例 Skill 或 Agent 被偷偷注册。发布自己的插件前修改 manifest 的 ID、name、description、version，以及工具名称、apps.json 的 tool 引用和业务文案。

## 实现流程

1. 写 `.vykor-plugin/plugin.json`，声明实际存在的组件及实际需要的权限。所有组件路径留在插件目录内。
2. 实现组件。Node 工具导出 `registerTools`，返回 `content` 内容块；参数、结果和错误都要有明确上限。UI 入口是提前构建的单文件 HTML。
3. 页面使用官方 MCP Apps：先注册通知和 hostContext，再 connect。按钮 await callServerTool 并显示返回值；通知共用显示函数，不再次执行工具。updateModelContext 加入可见条目，sendMessage 经确认交给助手，成功保留应用。参照 UI reference。
4. 运行与组件对应的检查。`vk` 不存在时，仍可以做 Node 语法检查和纯逻辑测试；明确说明宿主校验、真实激活和桌面交互尚未验证。
5. 给出输出目录、功能、请求的权限、实际跑过的检查和安装后的入口。安装、link、替换、发布都不是“创建插件”的默认动作。

## 工具＋应用构建

复制样例后执行 `npm ci`、`npm run build` 和 `node --check tools/index.mjs`。官方 ext-apps 锁定 1.1.2，esbuild 把页面源码和 SDK 内联进 panel.html；作者需要先安装构建依赖，最终用户离线安装生成产物，不运行构建。不要交付 node_modules，也不要手改 HTML。

`@vykor/plugins/sdk` 仍为 Native Tool 开发期类型入口，没有运行期 API。页面使用官方 `@modelcontextprotocol/ext-apps`，不另建页面 SDK。

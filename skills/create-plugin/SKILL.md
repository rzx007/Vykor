---
name: create-plugin
description: Create, extend, validate, or package an installable Vykor Native Plugin with Skills, Native Tools or MCP, and interactive UI. Includes an independent weather and travel starter. 不用于改造 Vykor 本身或转换其他产品的插件。
---

# 开发 Vykor 插件

把用户需要的能力做成可单独安装的 Native Plugin。交付真实文件、验证结果和使用方法，不只是目录示意。此 Skill 独立分发，不要求用户拥有 Vykor 源码。

## 先决定交付什么

- 只有可复用的提示词或操作说明：一个普通 Skill 就够了；用户明确要求插件包时，再加 Native manifest。
- 需要调用可执行代码：添加 Native Tool 或接入真实 MCP 服务。
- 需要人选择、确认、编辑结果：添加官方 MCP Apps 页面，由同插件 Native Tool 或 MCP 服务提供数据和操作。
- 需要自动监听事件：按用户要求添加 Hook，不把普通交互做成自动执行。

只声明用得上的组件。目的地已经明确时直接创建；否则在当前工作目录下选一个新目录。ID、外部服务、数据写入或权限存在关键歧义时才询问。不要覆盖已有目录，也不要修改已经安装的快照。

## 按需读取

所有相对路径都以本 Skill 目录为基准，不是以用户的工作目录为基准。

| 当前任务 | 需要读取的文件 |
| --- | --- |
| manifest、Skill、Agent、Hook、MCP、Node 工具 | [Native Plugin 接口](references/native-plugin.md) |
| 市场图标、介绍、使用示例与发布 | 上一份接口的“市场图标与使用示例”和 [验证与交付](references/verification.md) |
| 会话侧栏、确认按钮、自动保存 | 上一份接口说明和 [插件 UI](references/plugin-apps.md) |
| 校验、调试、安装说明、打包交付 | [验证与交付](references/verification.md) |

## 默认工具＋页面工程

需要完整可运行的工程时，用本 Skill 的初始化脚本生成天气与出行助手；不要手工复制整个仓库。先把下面的 `<skill-dir>` 换成当前 Skill 的绝对路径，输出目录相对于执行命令的位置：

```sh
node <skill-dir>/scripts/create-plugin.mjs --dir ./my-weather --id example.my-weather --name my-weather --backend native --display-name "我的天气助手" --version 1.0.0
cd my-weather
npm ci
npm run build
npm test
npm run validate
npm run pack
```

需要 Node.js 24，后台使用其内置 SQLite。`--backend native|mcp` 选择一种，省略时默认 native；两者使用同一业务代码与页面。Native 不启动额外 MCP 进程；MCP 通过 stdio 启动独立服务。生成器拒绝已有输出目录，并同步 `plugin.config.json`、根清单、工具前缀、页面 URI、包名和版本。插件内 Skill 的本名保持 `weather`，宿主入口为 `<name>:weather`。`--display-name` 和 `--version` 可省略，版本默认 `1.0.0`。详细能力与数据范围见 [模板说明](templates/weather-travel/README.md)。

这个起点包含真实城市搜索、当前与七日天气、逐小时数据、最多三个城市比较、收藏、会话出行备忘、有限自动保存、选区引用与 Markdown/JSON 导出。Open-Meteo 免费端点用于非商业评估；页面和文字保留来源、更新时间、时区及过期状态，不把测试响应当实时天气。其他产品可沿此工程替换业务，删去不用的组件与权限。

`assets/text-inspector/` 保留为只处理传入文本、无数据写入的进阶参考。仅在需要研究最小 Native Tools＋页面接线时读取，不能作为默认完整工程。它没有自动注册的 Skill 或 Agent。

## 实现流程

1. 写 `.vykor-plugin/plugin.json`，声明实际存在的组件及实际需要的权限。所有组件路径留在插件目录内。准备市场分发时，在根清单补齐作者图标、用途、详细介绍和可操作的使用示例；这些展示字段不授予权限，格式见 Native Plugin 接口。
2. 实现组件。Node 工具导出 `registerTools`，返回 `content` 内容块；参数、结果和错误都要有明确上限。UI 入口是提前构建的单文件 HTML。网络、插件数据与工作区导出分别声明；持久数据用宿主提供的 `plugin.dataDir`，不写安装快照。
3. 页面使用官方 MCP Apps：先注册通知和 hostContext，再 connect。按钮 await callServerTool 并显示返回值；通知共用显示函数，不再次执行工具。updateModelContext 加入可见条目，sendMessage 经确认交给助手，成功保留应用。参照 UI reference。
4. 运行与组件对应的检查。生成工程的 `npm run validate` 在仓库外也能检查文件、清单和页面声明；有 `vk` 时另做真实宿主校验。明确说明真实激活和桌面交互是否验证，不把构建成功当完整验收。按项目约定由用户查看样式，不主动搭建预览或截图。
5. 给出输出目录、功能、请求的权限、实际跑过的检查和安装后的入口。安装、link、替换、发布都不是“创建插件”的默认动作。

## 工具＋应用构建

默认工程锁定官方 `@modelcontextprotocol/ext-apps` 1.1.2、esbuild 0.25.12、JSZip 3.10.1；MCP 后台另用官方 `@modelcontextprotocol/sdk` 1.29.0。jsdom 26.1.0 仅用于测试。作者运行 `npm ci` 和构建；最终用户安装已构建的 ZIP，不运行 npm，也不需要本仓库。不要交付 node_modules 或手改生成的 HTML。

`@vykor/plugins/sdk` 仍为 Native Tool 开发期类型入口，没有运行期 API。页面使用官方 `@modelcontextprotocol/ext-apps`，不另建页面 SDK。

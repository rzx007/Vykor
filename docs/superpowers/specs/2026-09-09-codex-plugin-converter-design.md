# Codex 插件转换器首版

本文落实 [插件系统交接](../../plugin-system-handoff.md) 第 17 节的第一阶段，继续使用已确定的 Converter → Native Validator → Installer 流程。

## 输入依据

2026-09-09 核对了 [OpenAI 官方包格式说明](https://developers.openai.com/plugins/build/plugins)，并只读检查本机已安装的 Figma 2.0.21、Plugin Management 0.1.0 manifest。真实插件都使用 `.codex-plugin/plugin.json`，声明 `skills`、`apps` 和展示信息。测试使用独立编写的最小样本，不复制商业插件正文或用户凭据。

官方现在还支持带 `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` 的根级 manifest。这是外部输入，不能改变 Native Runtime 只读取 `.vykor-plugin/plugin.json` 的约束。

## 范围

- 注册 `codex` 转换器，让现有 CLI 的 `convert --from codex` 和 `install --from codex` 使用它。
- 支持 Codex manifest，以及上述明确版本的 portable manifest；不猜测任意根级 `plugin.json`。
- portable 格式的 identity 来自根 manifest，Skills 固定来自 `skills/`，MCP 固定来自 `mcp.json`；内联 `extensions.com.openai` 整体替代兼容 manifest 的扩展字段。
- legacy 格式读取声明的 Skills 和 MCP 路径，缺省时检查标准目录；声明路径必须以 `./` 开头且留在来源目录内。
- Skills 复制完整目录，包括相对引用的资源；保留其目录位置，并在 Native components 逐个声明 `SKILL.md`，避免把资源 Markdown 当作额外技能。
- MCP 只转换当前 Native 能表达的字段和传输方式；无法表达的认证、平台变量、相对程序路径等逐服务器报告 unsupported，绝不省略配置后声称等价。
- Apps、Hooks 和其他未实现能力逐项报告 unsupported，不进入可执行 manifest。保留基本名称、版本、说明和展示名称。
- 有损项必须通过 item ID 明确批准。未批准时不创建产物；只有 unsupported 内容时报告无法生成可安装插件。

## 流程与边界

`detect` 静态识别；`inspect` 校验 manifest 和路径、收集清单；`plan` 给出 exact/adapted/unsupported、所需批准和来源摘要；`convert` 重新检查来源和计划、生成临时目录、调用 Native Validator，通过后发布到新输出目录。

转换器不联网、不 import 源代码、不运行脚本或 MCP、不安装依赖，也不写安装状态。拒绝符号链接、目录联接、越界路径、输出嵌入源目录、已有输出和过期或被篡改的计划。失败清理本次临时目录。

共享来源摘要使用 `vykor-source-v2` 编码：排序后的每个文件写入 JSON 编码的路径、长度和内容 SHA-256，再计算总摘要。旧的「路径、零字节、原始内容」拼接允许二进制资源伪造文件边界，已经移除。旧转换计划需要重新生成；安装快照的 behavior digest 使用另一套现有实现，不受本次来源摘要变更影响。

网络与进程权限写入 Native manifest 供 Installer 再次要求批准；转换批准和安装权限批准分别处理。源插件声明的 Apps 权限不能自动变成 Native 权限。

## 方案选择

选择在 `plugin-converters/src/codex/` 独立实现解析与映射，复用现有 core 契约和 Native 校验。复用 Claude parser 会混淆默认目录、Apps 和 manifest 优先级；先改通用 core 则扩大本轮范围。

## 验收

测试覆盖自动识别和双格式歧义、legacy/portable 优先级、带资源的 Skills、MCP 映射、有损批准、坏 JSON、未知配置、路径与链接逃逸、来源变化、计划篡改、输出冲突、失败清理，以及 convert → validate → install → discover → load 的真实链路。测试不启动 MCP、不执行样本脚本。保留 Claude 原有回归。

## 真实样本静态回归

2026-09-09 使用本机已有缓存进行只读抽样，所有产物写入独立临时目录并在验证后清理：

| 样本 | 版本 | 静态加载 Skills | 转换状态 | 明确未转换 |
| --- | --- | --- | --- | --- |
| Figma | 2.0.21 | 12 | partial | Apps |
| Plugin Management | 0.1.0 | 1 | partial | Apps |

回归只调用 inspect、plan、convert、Native validate 和组件静态加载。测试程序在临时目录内显式传入 plan 的批准项，用于验证有损转换分支；没有替用户批准真实安装，也没有启动连接器、MCP 或源插件脚本。

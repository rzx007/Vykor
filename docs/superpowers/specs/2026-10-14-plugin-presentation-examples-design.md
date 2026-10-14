# 插件介绍、图标与示例提示词设计

## 目标

让仓库内的示例插件、内置「研究与写作」插件和随 create-plugin 分发的 Text Inspector 样例充分展示 Native Plugin 的图标、介绍和快速提示词。

## 方案

- 在每份目标 manifest 中补充 `icon`、`introduction` 和 `prompts`。
- 图标使用无外部请求的 Base64 SVG data URL；每个插件采用能表达其用途的简洁图形。
- `introduction` 使用 Markdown 说明插件能力和重要限制。
- `prompts` 提供少量可直接启动的典型任务，保持短小，不暗示插件未声明的能力。
- 两份 Text Inspector manifest 保持相同的展示内容；Agent Reviewer 与内置插件使用各自对应的介绍和提示词。
- 不修改 schema、Desktop 展示逻辑、权限或插件运行代码，也不改动当前工作区中其他未提交的功能实现。

## 覆盖范围

- `examples/plugins/agent-reviewer/.vykor-plugin/plugin.json`
- `examples/plugins/text-inspector/.vykor-plugin/plugin.json`
- `plugins/knowledge-work/.vykor-plugin/plugin.json`
- `skills/create-plugin/assets/text-inspector/.vykor-plugin/plugin.json`

## 验证

- 使用现有 Native Plugin manifest schema 校验四份 manifest。
- 确认两个 Text Inspector manifest 的三个展示字段一致。
- 运行插件 manifest schema 测试及 create-plugin 分发校验。
- 检查最终差异，确保只修改上述 manifest 和本规格文件。

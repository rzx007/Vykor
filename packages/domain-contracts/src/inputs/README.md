# 用户输入项与校验

定义一次用户输入中的文字、技能、提及、会话引用、插件能力引用及附件引用，并统一输入边界校验。

| 文件 | 用途 |
| --- | --- |
| [index.ts](index.ts) | `@vykor/domain-contracts/inputs` 公开入口 |
| [items.ts](items.ts) | 输入项类型、展示目录数据及数量与长度上限 |
| [validation.ts](validation.ts) | 输入项和附件引用解析、文字合并与文本提取 |
| [metadata.ts](metadata.ts) | 拒绝或移除仅允许宿主构造的插件元数据 |

调用方先用 `parseSessionInputItems` 解析未知值，再按需用 `sessionUserInputText` 得到文本表示；附件引用交给 `parsePromptAttachments`。普通输入的元数据可用 `assertPromptMetadataAllowed` 检查，防止冒充宿主创建的插件动作。

输入队列、附件内容和已接收输入由消费方保存，本目录只返回校验或整理结果。新增输入类型与对应校验放本目录，测试放 [__test__](__test__/)。

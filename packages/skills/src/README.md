# 技能解析与注册

公开入口是 `@vykor/skills` 的 [index.ts](index.ts)，导出注册表、加载器、目录发现、快照构建、Markdown 解析及内置技能。

| 文件 | 用途 |
| --- | --- |
| [index.ts](index.ts) | `SkillRegistry`、`SkillLoader`、目录发现和 `createSkillRegistrySnapshot()` |
| [parse-skill-markdown.ts](parse-skill-markdown.ts) | 技能元信息、字段别名、布尔值和正文默认值解析 |
| [bundled.ts](bundled.ts) | 内置技能正文和 `BUNDLED_SKILLS` 列表 |
| [__test__](__test__) | 解析、覆盖、查找、递归扫描和分发测试 |

宿主提供目录或定义后，加载器发现入口文件、读取 Markdown、解析元信息并注册。注册表保存短名称的有效定义，同时保留完整插件命令映射，`resolve()` 用于共享名称查找，`modelVisibleList()` 生成模型可见清单。快照构建按来源顺序重新加载，使移除的文件不再残留。

文件内容由磁盘提供，注册表和查找映射属于实例内存，本包不修改技能文件、不执行技能，也不保存会话选择。目录来源与技能调用由宿主控制。

新增元信息规则放 `parse-skill-markdown.ts`，注册或发现规则放 `index.ts`，内置技能放 `bundled.ts`。测试放同层 `__test__/`。返回[包说明](../README.md)。

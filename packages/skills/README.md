# @vykor/skills

读取 Markdown 技能文件、解析元信息，并建立供斜杠命令和模型调用使用的技能注册表。技能正文是给模型的操作说明，文件顶部的 YAML 头部决定发现方式、调用名称和展示信息。

## 目录与入口

公开入口是 [`src/index.ts`](src/index.ts)，通过 `@vykor/skills` 导入 `SkillRegistry`、`SkillLoader`、`parseSkillMarkdown()`、`createSkillRegistrySnapshot()` 和目录发现函数。

| 文件与目录 | 用途 |
| --- | --- |
| [src](src/README.md) | 源码导航、加载流程和状态归属 |
| [src/index.ts](src/index.ts) | 注册表、文件加载、快照重建和技能目录发现 |
| [src/parse-skill-markdown.ts](src/parse-skill-markdown.ts) | YAML 头部和正文默认值解析 |
| [src/bundled.ts](src/bundled.ts) | `BUNDLED_SKILLS` 内置技能正文 |
| [src/__test__](src/__test__) | 注册、解析、目录发现和技能分发测试 |

## 技能文件

```markdown
---
name: code-reviewer
description: Review code for correctness bugs
user-invocable: true
disable-model-invocation: false
model: gpt-5
argument-hint: <path>
command-name: review-code
display-name: Code Reviewer
---

# code-reviewer

Review the current diff and report correctness issues first.
```

支持 `name`、`description`、`user-invocable`、`disable-model-invocation`、`model`、`argument-hint`、`command-name`、`display-name`。含连字符的字段也支持下划线写法。缺少元信息时，解析器从正文标题、首段和文件名补齐名称与描述。

本地技能可以使用 `<名称>.md` 或 `<名称>/SKILL.md`。递归加载时，子目录只把 `SKILL.md` 作为入口，避免将 `references/` 等辅助文档注册为技能。

## 来源与覆盖顺序

`createSkillRegistrySnapshot()` 依次注册内置、baseline、插件、用户目录、项目目录的技能，同名项由后注册者覆盖。通常有效优先级为：

```text
bundled < plugin < user < project
```

目录由宿主传入，用户技能可来自配置目录的 `skills/`，默认配置目录为 `~/.vykor`。`standardUserSkillDirs()` 另提供 `~/.agents/skills` 与 `~/.config/agents/skills`。项目目录由 `findProjectSkillDirs()` 从 Git 根向工作目录逐层查找，每层按 `.agents/skills`、`.vykor/skills` 顺序返回，越靠近工作目录的同名技能优先。没有 Git 根时只查当前目录，个人技能目录会被排除在项目来源之外。

创建本地技能时，在所用用户或项目技能目录下写 `<名称>/SKILL.md`。内置 `create-skill` 技能也说明了创建方式，可由 `/create-skill` 或 `Skill` 工具读取；除非用户要求，不把新技能写到 `.agents/skills` 布局。

仓库的 [skills/create-plugin](../../skills/create-plugin/SKILL.md) 单独分发插件编写说明、参考资料和离线界面示例，不在 `BUNDLED_SKILLS` 中。需要安装到宿主加载的技能目录后才会被发现。

## 查找与调用

`SkillRegistry.resolve(name)` 是共享查找入口，顺序为：

1. 完整插件命令名，如 `office-work:officecli`。
2. 精确技能名。
3. 小写技能名。
4. 首字母大写技能名。
5. 其他精确 `commandName`。

完整插件命令名仍可找到插件技能，即使同名的用户或项目技能覆盖了短名称。`resolvePath()` 则按已加载文件路径查找。

用户可通过 `/review-code src/parser.ts` 调用允许用户调用的技能。CLI 先排除内置命令，再使用共享查找器检查 `userInvocable`，将技能正文与参数提交为模型输入；指定 `model` 时由 CLI 为该轮选择模型。

模型看到的清单来自 `modelVisibleList()`，其中排除 `disableModelInvocation: true` 的技能。模型需要完整说明时调用 `Skill` 工具，由宿主返回技能正文。

注册表的技能、非插件定义和完整插件命令映射都保存在实例内存中；文件是持久来源。重新构建快照可以让已删除的文件从有效注册表中消失。新增解析、加载和注册逻辑保持在 `src/`，测试放同层 `__test__/`。

## 测试

```bash
pnpm --filter @vykor/skills test
```

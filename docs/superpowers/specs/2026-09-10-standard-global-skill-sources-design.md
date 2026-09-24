# 标准全局 Skill 目录兼容设计

## 目标

让用户直接使用 `npx skills add` 的原有命令和目录规则，不拦截、不改写、不搬运安装结果。VK 在刷新技能时额外读取开放生态常用的个人级 Skill 目录，使这些技能能够在所有 VK 项目中使用。

## 支持目录

VK 读取的用户机器级技能来源扩展为：

1. `~/.agents/skills`
2. `~/.config/agents/skills`
3. `~/.vykor/skills`

前两个是外部生态的“通用”目录，最后一个仍是 VK 自有“个人”目录。目录不存在时安静跳过，不自动创建，也不建立软连接。

项目级目录保持现状：从 Git 根目录到当前工作目录逐层扫描 `.agents/skills`、`.vykor/skills` 和 `.claude/skills`。

## 优先级

加载顺序从低到高为：

```text
bundled < plugin < ~/.agents/skills < ~/.config/agents/skills
        < ~/.vykor/skills < project skills
```

同名技能以后加载者覆盖先加载者。因此：

- VK 用户自己放在 `~/.vykor/skills` 的版本优先于外部通用目录。
- 当前项目的技能优先于所有个人技能。
- 两个标准目录同时存在同名技能时，`~/.config/agents/skills` 优先于 `~/.agents/skills`，与列表顺序一致且可预测。

## 实现边界

`createSkillRegistrySnapshot` 从单个 `userDir` 扩展为兼容多个 `userDirs`，同时保留 `userDir` 以避免现有调用方一次性迁移。实际加载顺序为 `userDirs`，然后 `userDir`。

新增纯函数返回默认标准个人目录：

```ts
standardUserSkillDirs(homeDir = homedir()): string[]
```

默认运行时调用方传入：

```ts
userDirs: standardUserSkillDirs(),
userDir: getSkillsDir(),
```

涉及的两个统一装配入口是：

- `packages/agent-runtime/src/extensions.ts`：创建 Session 使用的技能注册表。
- `packages/tools/src/meta/skill.ts`：`Skill` / `ListSkills` 刷新文件系统时重建注册表。

CLI、Desktop 和后台任务最终复用这些入口，不分别实现目录扫描。

## 去重与安全

- 在加载前按规范化绝对路径去重；Windows 比较忽略大小写。
- 如果 `VYKOR_CONFIG_DIR` 将 VK 目录配置成某个标准目录，同一路径只加载一次，并仍按 VK 用户目录的优先位置处理。
- SkillLoader 保持现有读取和 frontmatter 校验，不执行安装脚本。
- 外部目录内容标记为 `source: "user"`，不会误显示成当前项目技能。
- `findProjectSkillDirs` 的个人目录排除集合加入 `~/.config/agents/skills`；当用户的 home 本身是 Git 仓库时，也不会把标准全局目录重复标成 project。
- 不扫描 Codex、Claude 等产品专属全局目录，避免无意扩大信任范围；本次只兼容通用 Agent Skills 目录。

## 用户行为

- 在项目里运行默认 `npx skills add ...`，结果位于项目 `.agents/skills` 时，VK 按现有项目扫描立即可见。
- 使用外部 CLI 安装到 `~/.agents/skills` 或 `~/.config/agents/skills` 后，VK 在下一次技能刷新时可见。
- 使用 VK 自带安装能力时，仍写入 `~/.vykor/skills`。
- VK 不改变 `npx` 命令，不承诺第三方 CLI 选择哪个 agent，也不接管第三方更新和卸载。

## 管理界面归类

`~/.agents/skills` 和 `~/.config/agents/skills` 使用新增的管理来源 `source: "standard"`，在技能管理界面显示为独立的“通用”分类：

- “通用”标签页合并展示两个标准目录，不再按目录拆成两个标签页。
- “个人”标签页只展示 `~/.vykor/skills`。
- 已安装列表和全局搜索仍同时包含通用、个人和项目技能。
- 技能详情继续显示真实文件路径，用户仍能判断它来自哪个目录。
- 通用技能由第三方 CLI 管理，VK 将其标记为只读，不显示删除操作；更新和卸载继续使用原安装工具。
- `~/.vykor/skills` 中的技能维持现有可删除行为。

服务端管理快照必须使用与运行时相同的标准目录函数和加载优先级，不能只让 Agent runtime 看见而管理界面漏掉。管理 API 的 `SkillSource` 新增 `"standard"`；运行时的 SkillRegistry 仍可把这些目录按 `user` 加载，因为模型只需要知道它们不是项目技能。

## 测试

- `standardUserSkillDirs` 在 Windows/POSIX 路径规则下返回两个标准目录。
- registry snapshot 按两个标准目录、VK 用户目录、项目目录的顺序覆盖同名技能。
- 重复的规范化目录只加载一次。
- `findProjectSkillDirs` 排除所有个人级目录。
- Agent runtime 和 Skill 工具都把标准目录传给统一 snapshot。
- Skill management service 把两个标准目录的技能返回为 `standard + readOnly`，管理界面的“通用”筛选能够显示它们。
- 运行 skills、agent-runtime、tools 的相关测试及全仓类型检查。

## 验收标准

- 不修改、不包装、不拦截 `npx skills add`。
- 不创建任何目录软连接。
- 两个标准全局目录中的合法 Skill 都可被模型调用。
- 标准目录技能在管理界面归入“通用”，删除操作仍交给第三方安装工具。
- VK 自有个人技能和项目技能保持更高优先级。
- 同一目录不会被重复加载或同时标为 user/project。

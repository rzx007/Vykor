# 标准全局 Skill 目录兼容实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** VK 不干预 `npx skills add`，直接发现 `~/.agents/skills` 和 `~/.config/agents/skills`，并在技能管理界面把它们归入独立、只读的“通用”类型。

**架构：** `@vykor/skills` 负责生成、规范化和去重标准全局目录，并让 registry snapshot 按“通用 → VK 个人 → 项目”加载。Agent runtime 和 Skill 工具复用该入口；Skill management service 使用同一目录函数，但向管理 API 返回独立的 `standard` 来源，Desktop 再将其映射到“通用”标签页。

**技术栈：** TypeScript、Node.js path/os、Vitest、React、Electron Desktop

---

## 文件职责

- 修改 `packages/skills/src/index.ts`：提供标准目录函数、多个 user 目录加载和规范化去重。
- 修改 `packages/skills/src/index.test.ts`：验证目录生成、优先级、重复目录和 project 排除。
- 修改 `packages/agent-runtime/src/extensions.ts`：Session 技能发现接入标准目录。
- 修改 `packages/agent-runtime/src/capability-resolution.test.ts`：验证 runtime snapshot 调用标准目录。
- 修改 `packages/tools/src/meta/skill.ts`：Skill/ListSkills 文件系统刷新接入标准目录。
- 修改 `packages/tools/src/meta/__test__/meta.test.ts`：验证刷新后发现标准全局技能。
- 修改 `packages/server/src/application/settings-api.ts`：管理来源增加 `standard`。
- 修改 `packages/server/src/application/skill-management-service.ts`：读取标准目录并返回只读通用技能。
- 修改 `packages/server/src/application/skill-management-service.test.ts`：验证通用、个人和项目的分类与删除边界。
- 修改 `apps/desktop/src/main/features/skill/skill-service.ts`：保留 `standard` 技能，不受项目过滤影响。
- 修改 `apps/desktop/src/main/features/skill/skill-service.test.ts`：验证 Desktop 主进程保留通用技能。
- 修改 `apps/desktop/src/renderer/src/components/desktop/plugin-page/skill-manager.tsx`：新增“通用”标签及筛选。
- 修改 `apps/desktop/src/renderer/src/components/desktop/plugin-page/skill-manager.test.tsx`：验证分类、搜索和只读详情。
- 修改 `apps/desktop/src/renderer/src/components/desktop/plugin-page/skill-detail.tsx`：显示“通用”来源文案。

### 任务 1：定义标准目录并扩展 Registry Snapshot

**文件：**

- 修改：`packages/skills/src/index.ts`
- 测试：`packages/skills/src/index.test.ts`

- [ ] **步骤 1：编写标准目录失败测试**

在 `index.test.ts` 增加：

```ts
it("returns the two standard user skill directories", () => {
  expect(standardUserSkillDirs("/home/dev")).toEqual([
    path.join("/home/dev", ".agents", "skills"),
    path.join("/home/dev", ".config", "agents", "skills"),
  ]);
});
```

函数接收显式 `homeDir`，测试不依赖 CI 用户目录。

- [ ] **步骤 2：编写多目录优先级和去重失败测试**

用临时目录分别创建同名 Skill：`standard-a`、`standard-b`、`personal`、`project`。调用：

```ts
const registry = await createSkillRegistrySnapshot({
  userDirs: [standardA, standardA, standardB],
  userDir: personal,
  projectDirs: [projectDir],
});
```

断言最终同名 Skill 来自 project；移除 project 后来自 personal；移除 personal 后来自 standard-b。再用 SkillLoader spy 或不同名称集合确认重复的 `standardA` 只加载一次。

- [ ] **步骤 3：扩展个人目录排除测试**

在 home 作为 Git 根目录的现有测试中加入：

```ts
expect(dirs).not.toContain(path.join(home, ".config", "agents", "skills"));
```

确保标准全局目录不会被标成 project。

- [ ] **步骤 4：运行测试确认红灯**

```powershell
pnpm --filter @vykor/skills test -- src/index.test.ts
```

预期：`standardUserSkillDirs` 和 `userDirs` 尚不存在，测试失败。

- [ ] **步骤 5：实现目录函数和多个用户目录**

在 `CreateSkillRegistrySnapshotOptions` 增加：

```ts
userDirs?: readonly string[]
```

导出：

```ts
export function standardUserSkillDirs(homeDir = homedir()): string[] {
  return [
    join(homeDir, ".agents", "skills"),
    join(homeDir, ".config", "agents", "skills"),
  ];
}
```

新增内部 `uniqueDirectories`：先 `resolve`，Windows 下用小写 key；同一路径后出现者优先。Registry 加载顺序固定为：

```ts
for (const directory of uniqueDirectories([
  ...(options.userDirs ?? []),
  ...(options.userDir ? [options.userDir] : []),
])) {
  await loader.loadFromDirectory(directory, {
    source: "user",
    recursive: true,
  });
}
```

把 `standardUserSkillDirs()` 的结果加入 `personalSkillDirectories()` 排除集合。

- [ ] **步骤 6：运行 Skills 完整测试**

```powershell
pnpm --filter @vykor/skills test
```

预期：全部 PASS。

- [ ] **步骤 7：提交目录基础能力**

```powershell
git add -- packages/skills/src/index.ts packages/skills/src/index.test.ts
git commit -m "feat(skills): discover standard global skill directories"
```

### 任务 2：接入 Agent Runtime 与 Skill 工具刷新

**文件：**

- 修改：`packages/agent-runtime/src/extensions.ts`
- 测试：`packages/agent-runtime/src/capability-resolution.test.ts`
- 修改：`packages/tools/src/meta/skill.ts`
- 测试：`packages/tools/src/meta/__test__/meta.test.ts`

- [ ] **步骤 1：编写 Agent runtime 失败测试**

在 agent-runtime 测试中 mock `standardUserSkillDirs` 返回两个固定目录，并监听 `createSkillRegistrySnapshot`，断言：

```ts
expect(createSkillRegistrySnapshot).toHaveBeenCalledWith(
  expect.objectContaining({
    userDirs: ["/home/test/.agents/skills", "/home/test/.config/agents/skills"],
    userDir: expect.any(String),
  }),
);
```

如果现有测试不适合模块 mock，则在临时 home 标准目录创建真实 Skill，通过 `discoverVykorExtensions` 断言 registry 能取到该技能。

- [ ] **步骤 2：编写 Skill 工具刷新失败测试**

在 `meta.test.ts` 的 `skillTool` 测试组中，使用临时 home 或 mock 标准目录创建 `standard-refresh/SKILL.md`，执行带 `refreshFilesystem` 路径的 `skillTool`，断言返回内容和 `source=user`。

- [ ] **步骤 3：运行测试确认红灯**

```powershell
pnpm --filter @vykor/agent-runtime test -- src/capability-resolution.test.ts
pnpm --filter @vykor/tools test -- src/meta/__test__/meta.test.ts
```

预期：两个入口都没有传 `userDirs`，标准技能不可见。

- [ ] **步骤 4：接入两个统一调用点**

在 `extensions.ts` 和 `meta/skill.ts` 从 `@vykor/skills` 引入 `standardUserSkillDirs`，并传入：

```ts
userDirs: standardUserSkillDirs(),
userDir: getSkillsDir(),
```

不修改 `npx`、Shell 或 bundled create-skill 指令。

- [ ] **步骤 5：运行两个包完整测试**

```powershell
pnpm --filter @vykor/agent-runtime test
pnpm --filter @vykor/tools test
```

预期：全部 PASS。

- [ ] **步骤 6：提交运行时接入**

```powershell
git add -- packages/agent-runtime/src/extensions.ts packages/agent-runtime/src/capability-resolution.test.ts packages/tools/src/meta/skill.ts packages/tools/src/meta/__test__/meta.test.ts
git commit -m "feat(runtime): load standard global skills"
```

### 任务 3：管理 API 增加通用来源

**文件：**

- 修改：`packages/server/src/application/settings-api.ts`
- 修改：`packages/server/src/application/skill-management-service.ts`
- 测试：`packages/server/src/application/skill-management-service.test.ts`

- [ ] **步骤 1：编写管理快照失败测试**

给 `SkillManagementServiceOptions` 的测试构造传入：

```ts
standardSkillsDirs: [standardAgents, standardConfigAgents];
```

分别写入两个 Skill，断言：

```ts
expect(snapshot.skills).toEqual(
  expect.arrayContaining([
    expect.objectContaining({
      name: "standard-a",
      source: "standard",
      readOnly: true,
    }),
    expect.objectContaining({
      name: "standard-b",
      source: "standard",
      readOnly: true,
    }),
    expect.objectContaining({
      name: "personal",
      source: "personal",
      readOnly: false,
    }),
  ]),
);
```

调用 `remove` 删除 standard skill，断言抛出“只读”。

- [ ] **步骤 2：编写路径重复与优先顺序测试**

将相同标准目录重复传入，并把 `personalSkillsDir` 也放进 `standardSkillsDirs`。断言每个真实文件只出现一次，VK 目录项目最终标为 `personal` 而不是 `standard`。

- [ ] **步骤 3：运行测试确认红灯**

```powershell
pnpm --filter @vykor/server exec vitest run src/application/skill-management-service.test.ts
```

预期：`standard` 不在 `SkillSource` 中，service 也不读取标准目录。

- [ ] **步骤 4：扩展类型和 Service 配置**

把管理 API 类型改为：

```ts
export type SkillSource =
  "bundled" | "agent" | "standard" | "project" | "personal";
```

`SkillManagementServiceOptions` 增加可注入字段：

```ts
standardSkillsDirs?: readonly string[]
```

构造器默认使用 `standardUserSkillDirs()`。`list()` 在 project/personal 之外加载标准目录，返回 `source: "standard"`。调整 `desktopSkill` 的只读规则：

```ts
readOnly: source === "bundled" || source === "agent" || source === "standard";
```

按规范化真实路径去重；VK personal 目录与标准目录重合时，由 personal 分类覆盖。

- [ ] **步骤 5：运行 Server 相关测试**

```powershell
pnpm --filter @vykor/server exec vitest run src/application/skill-management-service.test.ts src/http/__test__/http.test.ts
```

预期：全部 PASS，HTTP 快照可序列化 `standard`。

- [ ] **步骤 6：提交管理 API**

```powershell
git add -- packages/server/src/application/settings-api.ts packages/server/src/application/skill-management-service.ts packages/server/src/application/skill-management-service.test.ts
git commit -m "feat(skills): expose standard skills in management API"
```

### 任务 4：Desktop 管理界面增加“通用”分类

**文件：**

- 修改：`apps/desktop/src/main/features/skill/skill-service.ts`
- 测试：`apps/desktop/src/main/features/skill/skill-service.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/plugin-page/skill-manager.tsx`
- 测试：`apps/desktop/src/renderer/src/components/desktop/plugin-page/skill-manager.test.tsx`

- [ ] **步骤 1：编写主进程过滤失败测试**

在 daemon snapshot 中加入：

```ts
{
  id: "standard",
  name: "archify",
  source: "standard",
  readOnly: true,
  path: "C:/Users/dev/.agents/skills/archify/SKILL.md",
}
```

断言 `DesktopSkillService.snapshot()` 不会因缺少 `projectPath` 将它过滤掉。

- [ ] **步骤 2：编写管理界面失败测试**

扩展 `skill-manager.test.tsx` fixture，加入两个 standard 技能。断言标签顺序包含当前项目、“通用”、“个人”、其他项目；点击“通用”只显示 standard 技能，点击“个人”只显示 personal 技能。

打开 standard 详情并断言显示“通用 · 只读”，且不出现删除按钮。全局搜索和“已安装”区域仍能找到该技能。

- [ ] **步骤 3：运行 Desktop 测试确认红灯**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/main/features/skill/skill-service.test.ts src/renderer/src/components/desktop/plugin-page/skill-manager.test.tsx
```

预期：standard 被主进程过滤，界面没有“通用”标签。

- [ ] **步骤 4：保留通用来源并建立明确分类模型**

主进程过滤条件加入 `skill.source === "standard"`。

在 `skill-manager.tsx` 使用本地联合类型，避免用空路径或魔法路径代表来源：

```ts
type SkillCategory =
  | { kind: "standard"; name: "通用" }
  | { kind: "personal"; name: "个人" }
  | { kind: "project"; name: string; path: string };
```

`categoryId` 分别返回 `standard`、`personal`、`project:<path>`；`skillsFor` 按 `skill.source` 精确筛选。分类顺序为：当前项目、通用、个人、其他项目。

- [ ] **步骤 5：更新详情来源文案**

检查 `skill-detail.tsx` 的来源映射；为 `standard` 增加“通用”，并沿用 `readOnly` 控制删除按钮。列表项 aria-label 也应朗读“通用”。

- [ ] **步骤 6：运行 Desktop 完整测试与 Web 类型检查**

```powershell
pnpm --filter @vykor/desktop test
pnpm --filter @vykor/desktop run typecheck:web
```

预期：全部 PASS。

- [ ] **步骤 7：提交 Desktop 分类**

```powershell
git add -- apps/desktop/src/main/features/skill/skill-service.ts apps/desktop/src/main/features/skill/skill-service.test.ts apps/desktop/src/renderer/src/components/desktop/plugin-page/skill-manager.tsx apps/desktop/src/renderer/src/components/desktop/plugin-page/skill-manager.test.tsx apps/desktop/src/renderer/src/components/desktop/plugin-page/skill-detail.tsx
git commit -m "feat(desktop): group standard skills separately"
```

### 任务 5：整体验证

**文件：**

- 验证：前四项任务的全部文件

- [ ] **步骤 1：运行相关包测试**

```powershell
pnpm --filter @vykor/skills test
pnpm --filter @vykor/agent-runtime test
pnpm --filter @vykor/tools test
pnpm --filter @vykor/server test
pnpm --filter @vykor/desktop test
```

预期：全部 PASS；平台或真机 smoke 超时必须隔离复跑并如实记录。

- [ ] **步骤 2：运行全仓类型检查**

```powershell
pnpm check-types
```

预期：Turbo 报告全部任务成功。

- [ ] **步骤 3：验证没有命令拦截或软连接逻辑**

```powershell
rg -n "npx skills add|symlink|junction" packages/skills packages/agent-runtime packages/tools packages/server apps/desktop/src
```

人工核对新增代码只涉及发现和分类，没有 Shell 命令改写、安装后搬运或链接创建。

- [ ] **步骤 4：核对改动范围和工作区归属**

```powershell
git diff --check
git diff --name-only <实现前提交>..HEAD
git status --short
```

预期：实现提交只包含计划列出的文件；用户已有 `.claude/skills/shadcn` 变更保持原样且不进入本功能提交。

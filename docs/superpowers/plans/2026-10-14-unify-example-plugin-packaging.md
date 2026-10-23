# 统一示例插件源码与打包实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将所有可维护的示例和测试插件源码放在 `examples/plugins`，并提供一个可重复运行的命令，把每个插件打包为 `.plugin-dist` 下的 ZIP。

**架构：** 在 `packages/plugin-sources` 新增基于现有 JSZip 依赖的 Node 脚本。脚本扫描示例插件目录，校验每个直接子目录都有 Native Plugin 清单，再逐个生成保留顶层插件目录的 ZIP。Agent Reviewer 源码迁入 `examples/plugins`；文档统一改为调用这个脚本，生成物由 Git 忽略。

**技术栈：** Node.js ESM、JSZip、Vitest、pnpm。

---

## 文件与职责

- 创建 `packages/plugin-sources/scripts/package-example-plugins.mjs`：负责扫描、校验并生成示例插件 ZIP；导出可由测试调用的打包函数，命令行入口使用仓库默认路径。
- 创建 `packages/plugin-sources/scripts/__test__/package-example-plugins.test.ts`：沿用 Vitest 当前的 `src/**/*.test.ts` 匹配规则，用临时插件目录验证 ZIP 内容、覆盖行为、无关文件保留和清单错误。
- 修改 `packages/plugin-sources/package.json`：增加 `package:examples` 命令。
- 移动 `artifacts/plugin-test/agent-reviewer/` 至 `examples/plugins/agent-reviewer/`：将 Agent Reviewer 唯一源码放在示例插件目录。
- 修改 `.gitignore`：忽略仓库根目录的 `.plugin-dist/`。
- 修改 `examples/plugins/text-inspector/README.md` 和 `docs/native-plugin-authoring.md`：用统一命令替换手工打包 ZIP 命令，并保留 Desktop 支持的归档格式及导入说明。

### 任务 1：实现并测试示例插件打包器

**文件：**
- 创建：`packages/plugin-sources/scripts/package-example-plugins.mjs`
- 创建：`packages/plugin-sources/scripts/__test__/package-example-plugins.test.ts`
- 修改：`packages/plugin-sources/package.json`

- [x] **步骤 1：编写打包器失败测试**

新增 Vitest 测试。每个测试在系统临时目录创建自己的 `plugins` 和 `dist` 目录，并在 `afterEach` 删除临时目录。

```js
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import JSZip from "jszip";
import { afterEach, expect, it } from "vitest";

import { packageExamplePlugins } from "../scripts/package-example-plugins.mjs";

const tempRoots: string[] = [];

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "vykor-example-plugins-"));
  tempRoots.push(root);
  return {
    pluginsDir: join(root, "plugins"),
    outputDir: join(root, "dist"),
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function addPlugin(pluginsDir: string, name: string): Promise<void> {
  const pluginDir = join(pluginsDir, name);
  await mkdir(join(pluginDir, ".vykor-plugin"), { recursive: true });
  await writeFile(join(pluginDir, ".vykor-plugin", "plugin.json"), JSON.stringify({ id: name }));
  await writeFile(join(pluginDir, "README.md"), `# ${name}`);
}

it("packages every plugin with its top-level folder and hidden manifest", async () => {
  const { pluginsDir, outputDir } = await createFixture();
  await addPlugin(pluginsDir, "alpha");
  await addPlugin(pluginsDir, "beta");

  const archives = await packageExamplePlugins(pluginsDir, outputDir);

  expect(archives.map((archive) => basename(archive))).toEqual(["alpha.zip", "beta.zip"]);
  const zip = await JSZip.loadAsync(await readFile(join(outputDir, "alpha.zip")));
  expect(zip.file("alpha/.vykor-plugin/plugin.json")).not.toBeNull();
  expect(zip.file("alpha/README.md")).not.toBeNull();
});

it("overwrites its own archive and leaves unrelated output files alone", async () => {
  const { pluginsDir, outputDir } = await createFixture();
  await addPlugin(pluginsDir, "alpha");
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "alpha.zip"), "old archive");
  await writeFile(join(outputDir, "keep.txt"), "keep");

  await packageExamplePlugins(pluginsDir, outputDir);

  expect(await readFile(join(outputDir, "keep.txt"), "utf8")).toBe("keep");
  const zip = await JSZip.loadAsync(await readFile(join(outputDir, "alpha.zip")));
  expect(zip.file("alpha/README.md")).not.toBeNull();
});

it("fails when a direct child directory has no Native Plugin manifest", async () => {
  const { pluginsDir, outputDir } = await createFixture();
  await mkdir(join(pluginsDir, "not-a-plugin"), { recursive: true });

  await expect(packageExamplePlugins(pluginsDir, outputDir))
    .rejects.toThrow(/not-a-plugin.*plugin\.json/i);
});
```

- [x] **步骤 2：运行新测试，确认它因打包器尚不存在而失败**

运行：`pnpm --filter @vykor/plugin-sources exec vitest run src/package-example-plugins.test.ts`

预期：测试启动失败，报告找不到 `package-example-plugins.mjs`；确认不是测试断言或依赖缺失导致。

- [x] **步骤 3：实现打包函数、命令行入口和 pnpm 命令**

在 `package-example-plugins.mjs` 中导出 `packageExamplePlugins(pluginsDir, outputDir)`，并按以下顺序工作：

1. 读取 `pluginsDir` 的直接子目录并按目录名排序；目录不可读或没有子目录时抛出有说明的错误。
2. 确认每个子目录都能读取 `.vykor-plugin/plugin.json`；缺失或不可读时指出插件目录并抛错。
3. 创建 `outputDir`，为每个插件创建 `<目录名>.zip`。递归读取插件目录中的普通文件，路径写入 ZIP 时加上 `<目录名>/` 前缀，包含点号开头的清单目录。
4. 只覆盖对应的 ZIP，不清空输出目录，也不删除其他输出文件。
5. 从脚本位置解析仓库根目录，使调用者无论当前目录在哪里都输出到仓库根目录的 `.plugin-dist`。直接执行脚本时逐个打印已生成的 ZIP；打包失败时将错误写到 stderr 并设置非零退出码。

在 `packages/plugin-sources/package.json` 的 `scripts` 中增加：

```json
"package:examples": "node scripts/package-example-plugins.mjs"
```

- [x] **步骤 4：运行打包器测试，确认通过**

运行：`pnpm --filter @vykor/plugin-sources exec vitest run src/package-example-plugins.test.ts`

预期：3 个测试通过；生成的 ZIP 可由 JSZip 重新读取，包含隐藏清单和顶层插件目录。

- [x] **步骤 5：提交打包器及其测试**

```powershell
git add -- packages/plugin-sources/package.json packages/plugin-sources/scripts/package-example-plugins.mjs packages/plugin-sources/scripts/__test__/package-example-plugins.test.ts
git commit --only -m "feat(插件打包): 添加示例插件 ZIP 生成命令" -m "复用 JSZip 将示例插件源码打包到本地分发目录，并覆盖缺失清单、重复构建和无关文件保留行为。" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -- packages/plugin-sources/package.json packages/plugin-sources/scripts/package-example-plugins.mjs packages/plugin-sources/scripts/package-example-plugins.test.mjs
```

### 任务 2：集中插件源码并接通文档流程

**文件：**
- 移动：`artifacts/plugin-test/agent-reviewer/` → `examples/plugins/agent-reviewer/`
- 修改：`.gitignore`
- 修改：`examples/plugins/text-inspector/README.md`
- 修改：`docs/native-plugin-authoring.md`

- [x] **步骤 1：迁移 Agent Reviewer 源码**

运行：`git mv artifacts/plugin-test/agent-reviewer examples/plugins/agent-reviewer`

预期：manifest、README 和 `agents/reviewer.md` 原样保留；插件 ID 仍是 `example.agent-reviewer`。不要恢复或暂存 `artifacts/plugin-test` 下两个已删除的 ZIP。

- [x] **步骤 2：忽略本地 ZIP 输出目录**

在 `.gitignore` 增加仓库根目录规则：

```gitignore
.plugin-dist/
```

- [x] **步骤 3：替换两份文档中的手动 ZIP 命令**

在 Text Inspector README 和原生插件开发指南的打包部分使用相同命令：

```sh
pnpm --filter @vykor/plugin-sources package:examples
```

说明该命令会为 `examples/plugins` 中每个插件生成 `.plugin-dist/<插件目录名>.zip`，ZIP 可在 Desktop 插件页导入。保留 Desktop 仍支持 `.tar`、`.tar.gz` 和 `.tgz` 的说明，但不要保留原先要求手工运行 `Compress-Archive` 的步骤。

- [x] **步骤 4：运行插件来源测试和真实打包命令**

运行：

```powershell
pnpm --filter @vykor/plugin-sources test
pnpm --filter @vykor/plugin-sources package:examples
git check-ignore -- .plugin-dist/agent-reviewer.zip .plugin-dist/text-inspector.zip
git status --short
```

预期：插件来源测试通过；输出目录同时有两个 ZIP；`git check-ignore` 将两个归档都识别为忽略文件；状态只显示本次源码、脚本、文档变更及两个旧 ZIP 的既有删除，不显示 `.plugin-dist` 内的生成包。

- [x] **步骤 5：提交源码归位和文档更新**

```powershell
git add -- .gitignore docs/native-plugin-authoring.md examples/plugins/agent-reviewer
git add -u -- artifacts/plugin-test/agent-reviewer
git commit --only -m "refactor(示例插件): 统一源码与打包入口" -m "将 Agent Reviewer 源码迁入 examples/plugins，并让插件文档统一使用批量 ZIP 生成命令。生成归档留在被忽略的本地目录。" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -- .gitignore docs/native-plugin-authoring.md examples/plugins/agent-reviewer artifacts/plugin-test/agent-reviewer
```

不要把 `artifacts/plugin-test/agent-reviewer-native-plugin.zip` 或 `artifacts/plugin-test/text-inspector-native-plugin.zip` 加回版本控制。

## 完成检查

- `pnpm --filter @vykor/plugin-sources exec vitest run src/package-example-plugins.test.ts`：3 个测试通过。
- `pnpm --filter @vykor/plugin-sources test`：插件来源测试通过。
- `pnpm --filter @vykor/plugin-sources package:examples`：生成 Agent Reviewer 和 Text Inspector 两个 ZIP。
- `git check-ignore -- .plugin-dist/agent-reviewer.zip .plugin-dist/text-inspector.zip`：两个生成文件均被忽略。
- `git status --short`：不包含生成 ZIP；两个旧 ZIP 仍保持用户已有的删除状态。

# Native 插件转换收口实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** Claude Code 插件经过转换后成为普通 Vykor Native Plugin；安装、运行和管理不再依赖 Claude 源目录结构，非链接安装只保留一个当前缓存。

**架构：** Converter 读取 Claude Code 源目录，将已支持的组件和它们需要的资源写入标准 Native Plugin 目录，并在 manifest metadata 与转换报告中留下来源信息。Installer 只接收通过 Native 校验的目录，统一复制到 `cache/<plugin-id>/current/`，从 manifest metadata 生成 installed record；Runtime 只读取 Native manifest 声明的组件。

**技术栈：** TypeScript、Node.js `fs/promises`、Vitest、Vykor Native Plugin validator/loader。

---

## 文件职责

- `packages/plugin-converters/src/claude-code/converter.ts`：把 Claude 组件转换或复制到 Native 顶层目录，生成 Native manifest 和转换审计文件。
- `packages/plugin-converters/src/claude-code/converter.test.ts`：约束转换目录、manifest 来源字段，以及不存在 Claude `payload/generated` 包装层。
- `packages/plugin-converters/src/acceptance.test.ts`：证明转换产物能直接走 Native validate/install/discover/load 流程。
- `packages/plugins/src/installation/cache.ts`：原子替换 `cache/<plugin-id>/current/`，失败时恢复旧缓存。
- `packages/plugins/src/installation/cache.test.ts`：约束单目录缓存、重装替换和失败回滚。
- `packages/plugins/src/installation/installer.ts`：从 Native manifest metadata 读取通用来源信息，不解析 Claude 源结构。
- `packages/plugins/src/installation/installer.test.ts`：约束缓存路径和 converted 来源识别。
- `docs/superpowers/specs/2026-08-25-native-plugin-and-converters-design.md`：修正转换产物和各层职责。
- `docs/plugins-contributions-design.md`：更新面向贡献者的实际目录与安装流程。

### 任务 1：锁定转换后的 Native 目录契约

- [x] **步骤 1：编写失败测试**

在 `converter.test.ts` 中对真实 fixture 执行转换，并断言：

```ts
expect(await readdir(output)).toEqual([
  ".vykor-conversion",
  ".vykor-plugin",
  "agents",
  "hooks.json",
  "mcp.json",
  "skills",
]);
expect(await pathExists(join(output, "payload"))).toBe(false);
expect(await pathExists(join(output, "generated"))).toBe(false);
expect(manifest.metadata).toMatchObject({
  origin: "converted",
  sourceFormat: "claude-code",
});
expect(manifest.components.agents).toEqual(["./agents"]);
```

这个测试要抓住的破坏是：Converter 又把源插件整体塞入 `payload/`，或者 Native manifest 仍引用转换器内部目录。

- [x] **步骤 2：确认红灯**

运行：

```powershell
..\..\node_modules\.bin\vitest.CMD run src/claude-code/converter.test.ts
```

预期：目录与 manifest 路径断言失败，因为当前实现仍生成 `payload/` 和 `generated/`。

- [x] **步骤 3：最少实现**

修改 `converter.ts`：

- 原生 Claude skill 复制到 `skills/`，连同 skill 同目录的 scripts/assets 一起复制；
- command 转成 `skills/<command>/SKILL.md`；
- agent 转成 `agents/`；
- hooks 和 MCP 分别写到 `hooks.json`、`mcp.json`；
- manifest component 只引用这些 Native 路径；
- manifest metadata 写入 `origin`、`sourceFormat`、`converterId` 和 `converterVersion`；
- 不复制 `.claude-plugin/` 和未声明为已支持组件的源文件。

- [x] **步骤 4：确认绿灯**

运行同一测试文件，预期全部 PASS。

### 任务 2：让 Installer 只消费 Native 信息

- [x] **步骤 1：编写失败测试**

在 `installer.test.ts` 新建带有以下 metadata 的 Native fixture，安装后断言 record：

```json
{
  "origin": "converted",
  "sourceFormat": "claude-code",
  "converterId": "claude-code",
  "converterVersion": "1.0.0"
}
```

```ts
expect(result.record.origin).toBe("converted");
expect(result.record.sourceFormat).toBe("claude-code");
```

测试目录不创建 `.vykor-conversion/`。这个测试要抓住的破坏是：Installer 仍必须读取转换报告才能识别来源。

- [x] **步骤 2：确认红灯**

运行：

```powershell
..\..\node_modules\.bin\vitest.CMD run src/installation/installer.test.ts
```

预期：record 被识别为 `native`。

- [x] **步骤 3：最少实现并确认绿灯**

Installer 从经过校验的 manifest metadata 读取通用来源字段；显式安装参数仍优先。删除对 `.vykor-conversion/provenance.json` 的安装依赖，再运行测试预期 PASS。

### 任务 3：收口为单一当前缓存

- [x] **步骤 1：补充失败回滚测试**

保留已写的重装替换测试，并新增可观察的失败场景：目标替换失败时旧 `current` 内容仍可读，且 `.tmp-*` / `.previous-*` 不残留。这个测试要抓住的破坏是：重装中途失败导致已安装插件目录消失。

- [x] **步骤 2：确认红灯**

运行：

```powershell
..\..\node_modules\.bin\vitest.CMD run src/installation/cache.test.ts
```

若当前实现无法稳定注入替换失败，不为测试增加生产专用 API；改为核对现有异常分支并用安装集成测试覆盖成功替换。

- [x] **步骤 3：实现并确认绿灯**

`materializePluginCache` 使用同插件目录内的临时目录完成复制，切换前保存旧 `current`，成功后删除旧目录，失败则恢复。目录最终只能留下 `current`。

### 任务 4：端到端和文档收口

- [x] **步骤 1：扩展 acceptance 测试**

转换、校验、安装、发现、加载之后，断言 installed cache 为 `cache/<id>/current`，缓存中没有 `payload/`、`generated/` 和 `.claude-plugin/`，Skills 与 Agents 均可加载。

- [x] **步骤 2：修正规范**

明确 Converter 的终点是 Native Plugin 目录；`.vykor-conversion/` 只用于审计，Installer 和 Runtime 不依赖它；版本只记录在 manifest/installed store，不保留历史缓存目录。

- [x] **步骤 3：完整验证**

```powershell
..\..\node_modules\.bin\vitest.CMD run
..\..\node_modules\.bin\tsc.CMD --noEmit
```

分别在 `packages/plugin-converters` 和 `packages/plugins` 执行，确认 0 个失败后再声明完成。

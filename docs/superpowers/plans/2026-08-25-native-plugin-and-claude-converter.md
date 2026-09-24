# Native Plugin v1 与 Claude Code Converter 实施计划

> **执行说明：** 按 Task 顺序实施，并用复选框跟踪。项目偏好中的 superpower 当前不可用；恢复后可使用 `superpowers:executing-plans` 或 `superpowers:subagent-driven-development` 逐任务执行。

> **实施结果（2026-08-25）：** Native v1、安装状态、Runtime/Server/Client/CLI 硬切、Converter core、Claude Code 转换与仓库级验收均已落地。下方逐步复选框保留为实现过程和回归清单；建议提交步骤未执行，因为本次没有获得创建 Git commit 的明确授权。

**目标：** 用版本化 Vykor Native Plugin v1 替换当前临时插件格式，让 Runtime 只加载原生插件；随后实现独立 Converter core 和 Claude Code Converter，把 Claude Skills、Commands、Agents、Hooks、MCP 转换、校验并安装为原生插件。

**架构：** `@vykor/plugins` 拥有 Native schema、组件加载、安装状态、当前 cache 和 Runtime 激活；新的 `@vykor/plugin-converters` 只负责外部 source 的 detect、inspect、plan、convert，并生成可直接安装的 Native Plugin 与 provenance/report。CLI 的转换命令可以本地只读运行，所有 installed state 变更经 daemon PluginService 和 mutation barrier 完成。Runtime、Server、Client 和 CLI 不直接解析 Claude manifest。

**技术栈：** TypeScript 5.7、Zod、Node.js fs/path/crypto、Hono、Commander、Vitest、pnpm/Turbo。

**设计：** `docs/superpowers/specs/2026-08-25-native-plugin-and-converters-design.md`

## 实施范围

本计划实现设计阶段 1 和阶段 2：

1. Native Plugin v1 schema、Validator、Skills/Agents/Hooks/MCP、安装 cache、installed store、激活、API 和 CLI。
2. Converter SPI、provenance、plan/report、Claude Code Skills/Commands/Agents/Hooks/MCP 转换。
3. 当前临时格式硬切删除。

本计划不实现：

- Codex Converter；
- Git/npm/archive/Marketplace 下载；
- Desktop 插件管理页；
- LSP、Output Styles、Themes、Monitors；
- Workflows、Channels、Providers、UI contributions；
- 第三方 Converter；
- Native Tool 激活。v1 schema 可以识别 Tool component，但在隔离 Runtime 完成前必须返回 `unsupported`/`blocked`；后续计划见 `docs/superpowers/plans/2026-08-25-native-tool-isolated-runtime.md`；
- 自动转换旧 Vykor 插件。

## 全局约束

- Native Plugin 是 Runtime 唯一插件格式；禁止在 `agent-runtime` 增加 Claude/Codex 分支。
- 不保留根级旧 `plugin.json`、snake_case 字段、`allowProjectPlugins` 或 `tools_dir` 兼容别名。
- Converter 不执行源代码、不启动 MCP/Hook、不安装依赖、不联网。
- 所有 source/native component path 都经过统一 canonical-path 和 symlink 边界校验。
- 转换必须先产生 plan；`blocked` component 未批准时不能物化。
- Runtime 行为 digest 排除时间戳和本机绝对路径。
- installed store 是安装/启停真相；manifest 不保存安装状态。
- 生产安装状态的唯一写 owner 是 daemon PluginService。CLI 不直接并发改 `installed.json`。
- `composeVykorAgent()` 等独立 SDK 入口可以只读 installed store，但不能从 Runtime 修改插件。
- Runtime reload 继续使用 daemon mutation barrier；active run 存在时返回 409。
- 插件版本切换必须先写完整新 cache，再原子更新 installed state；失败保留旧版本。
- 使用 TDD：先写行为测试并看到预期失败，再实现最小生产变化。
- 工作区已有其他未提交改动。编辑 dirty target 前先执行 `git diff -- <file>`，完成后确认无关 hunk 保留；不得提交无关文件。
- 每个 Task 提交前运行 `git diff --check` 和对应 package typecheck。

## 目标包边界

```text
@vykor/plugins
  Native schema / validate / load / install / activate

@vykor/plugin-converters
  Converter core / Claude Code Converter

@vykor/agent-runtime
  消费已验证 Native Plugin，不解析外部格式

@vykor/server
  PluginService、mutation barrier、HTTP resources

@vykor/client
  PluginInfo、install/enable/disable/reload/conversion transport

apps/cli
  plugin/source/conversion 命令薄适配
```

## 文件地图

### 新包和核心文件

- `packages/plugins/src/manifest/schema-v1.ts`
- `packages/plugins/src/manifest/validate.ts`
- `packages/plugins/src/paths.ts`
- `packages/plugins/src/diagnostics.ts`
- `packages/plugins/src/types.ts`
- `packages/plugins/src/components/{skills,agents,hooks,mcp}.ts`
- `packages/plugins/src/installation/{store,cache,installer}.ts`
- `packages/plugins/src/activation/activate.ts`
- `packages/plugin-converters/package.json`
- `packages/plugin-converters/tsconfig.json`
- `packages/plugin-converters/src/core/{converter,registry,plan,report,digest}.ts`
- `packages/plugin-converters/src/claude-code/{detector,parser,mappings,converter}.ts`
- `packages/plugin-converters/src/index.ts`

### 主要修改文件

- `packages/agent-runtime/src/extensions.ts`
- `packages/agent-runtime/src/agent-composition.ts`
- `packages/core/src/types/settings.ts`
- `packages/server/src/application/settings-api.ts`
- `packages/server/src/application/default-services/plugin-service.ts`
- `packages/server/src/http/routes/service.ts`
- `packages/client/src/types/index.ts`
- `packages/client/src/transport/http-client.ts`
- `packages/client/src/commands/session-commands.ts`
- `apps/cli/src/commands/plugin.ts`
- `docs/plugins-contributions-design.md`
- `docs/slash-commands.md`
- `README.md`

### 删除目标

- `packages/plugins/src/discovery.ts`
- `packages/plugins/src/contributions.ts`
- `packages/plugins/src/hooks-mcp.ts`
- `packages/plugins/src/agents.ts`
- 对应旧测试文件；
- `apps/cli/src/plugin-contributions.ts`
- `apps/cli/src/plugin-contributions.test.ts`
- `packages/agent-runtime/src/extensions.ts` 中的旧 `registerPluginTools()`；
- `packages/plugins/src/index.ts` 中旧 `PluginInstaller`；
- `Settings.plugins` 和 `Settings.allowProjectPlugins`。

---

## Task 1：定义 Native Plugin v1 schema、诊断和路径边界

**文件：**

- Create: `packages/plugins/src/manifest/schema-v1.ts`
- Create: `packages/plugins/src/manifest/schema-v1.test.ts`
- Create: `packages/plugins/src/manifest/validate.ts`
- Create: `packages/plugins/src/manifest/validate.test.ts`
- Create: `packages/plugins/src/paths.ts`
- Create: `packages/plugins/src/paths.test.ts`
- Create: `packages/plugins/src/diagnostics.ts`
- Create: `packages/plugins/src/types.ts`
- Modify: `packages/plugins/src/index.ts`

**产出接口：**

```ts
export const VykorPluginManifestV1Schema: z.ZodType<VykorPluginManifestV1>;

export interface NativePluginValidationResult {
  status: "valid" | "invalid";
  plugin?: ValidatedNativePlugin;
  diagnostics: PluginDiagnostic[];
}

export async function validateNativePlugin(
  root: string,
): Promise<NativePluginValidationResult>;

export async function resolveNativePluginPath(
  root: string,
  declaredPath: string,
): Promise<string>;
```

- [x] **Step 1：写 manifest schema 失败测试**

覆盖：

- `schemaVersion` 必须等于 1；
- `id` 使用反向域名或稳定 dotted ID，至少两段；
- `name` 使用 kebab-case；
- version 是非空字符串，首版不强制完整 semver 解析；
- components 至少有一个声明；
- component path 必须以 `./` 开头；
- 未知顶层执行字段报错，metadata 类扩展必须放入明确字段；
- `components.tools` 可以解析，但标记为 v1 recognized/not-yet-activatable。

- [x] **Step 2：运行测试并确认旧 schema 不满足新接口**

```bash
pnpm --filter @vykor/plugins exec vitest run src/manifest/schema-v1.test.ts
```

预期：FAIL，因为 Native v1 schema 尚不存在。

- [x] **Step 3：实现最小 schema 和公共类型**

不要导出当前 `PluginManifestSchema` 的别名；使用全新名称并让调用方显式迁移。

- [x] **Step 4：写路径攻击测试**

至少覆盖：

```text
../outside
./../outside
绝对 Windows 路径
不同盘符
UNC path
插件内 symlink -> 插件外
插件内 symlink -> 插件内
大小写不同但同一路径的 Windows 情况
```

在不能创建 symlink 的 Windows 环境中，测试应检测权限并只跳过 symlink 个案，不跳过普通穿越测试。

- [x] **Step 5：实现 canonical path validator**

先 `resolve` declared path，再对存在路径使用 `realpath`；对尚未存在的生成目标逐级检查最近存在父目录。不得仅使用字符串 `startsWith(root)`，必须处理目录分隔边界。

- [x] **Step 6：实现 Native validator 和结构化诊断**

损坏 JSON、缺失 manifest、非法 component path、重复 component source 都返回 `PluginDiagnostic[]`，不能只 catch 后返回 null。

- [x] **Step 7：运行包检查**

```bash
pnpm --filter @vykor/plugins exec vitest run src/manifest src/paths.test.ts
pnpm --filter @vykor/plugins check-types
git diff --check
```

- [ ] **Step 8：提交 schema slice**

建议提交：`feat(plugins): define native plugin v1 schema`

---

## Task 2：实现 Native Skills、Agents、Hooks 和 MCP component loader

**文件：**

- Create: `packages/plugins/src/components/skills.ts`
- Create: `packages/plugins/src/components/skills.test.ts`
- Create: `packages/plugins/src/components/agents.ts`
- Create: `packages/plugins/src/components/agents.test.ts`
- Create: `packages/plugins/src/components/hooks.ts`
- Create: `packages/plugins/src/components/hooks.test.ts`
- Create: `packages/plugins/src/components/mcp.ts`
- Create: `packages/plugins/src/components/mcp.test.ts`
- Create: `packages/plugins/src/load-native-plugin.ts`
- Create: `packages/plugins/src/load-native-plugin.test.ts`
- Modify: `packages/plugins/src/index.ts`

**产出接口：**

```ts
export interface LoadedNativePlugin {
  manifest: VykorPluginManifestV1;
  root: string;
  components: NativePluginComponents;
  diagnostics: PluginDiagnostic[];
}

export async function loadNativePlugin(
  validated: ValidatedNativePlugin,
): Promise<LoadedNativePlugin>;
```

- [x] **Step 1：建立离线 Native fixtures**

创建：

```text
packages/plugins/fixtures/native-v1/minimal-skill/
packages/plugins/fixtures/native-v1/agents-hooks-mcp/
packages/plugins/fixtures/native-v1/invalid-component/
packages/plugins/fixtures/native-v1/unsupported-tool/
```

- [x] **Step 2：写 component 行为测试**

断言：

- Skill namespace 使用 manifest `name`；
- Agent identity 使用 plugin ID + scoped name；
- Native Hook 文件使用 Vykor 事件名，不接受 Claude `PostToolUse`；
- Native MCP 要求明确内部 transport/type；
- 一个 component 文件损坏时其他独立 component 继续加载，插件状态变为 degraded；
- Tools 在本阶段返回 recognized-but-unsupported diagnostic；
- Loader 不扫描 manifest 未声明的目录。

- [x] **Step 3：运行失败测试**

```bash
pnpm --filter @vykor/plugins exec vitest run src/components src/load-native-plugin.test.ts
```

- [x] **Step 4：复用内部 Skill/Agent/Hook/MCP 类型实现 loader**

Native loader 可以复用 `@vykor/skills` 和 `@vykor/coordinator` 的解析器，但不得复用旧 Claude 风格默认目录逻辑。所有文件必须来自已验证 manifest source。

- [x] **Step 5：定义 component 级结果**

```ts
interface PluginComponentResult<T> {
  status: "loaded" | "unsupported" | "invalid" | "blocked";
  value?: T;
  diagnostics: PluginDiagnostic[];
}
```

不要因为 `.mcp.json` 损坏而让 Skills 从列表消失。

- [x] **Step 6：运行包测试和 typecheck**

```bash
pnpm --filter @vykor/plugins exec vitest run src/components src/load-native-plugin.test.ts
pnpm --filter @vykor/plugins check-types
```

- [ ] **Step 7：提交 component slice**

建议提交：`feat(plugins): load native plugin components`

---

## Task 3：实现 installed store、当前 cache、plugin data 和本地安装

**文件：**

- Create: `packages/plugins/src/installation/store.ts`
- Create: `packages/plugins/src/installation/store.test.ts`
- Create: `packages/plugins/src/installation/cache.ts`
- Create: `packages/plugins/src/installation/cache.test.ts`
- Create: `packages/plugins/src/installation/installer.ts`
- Create: `packages/plugins/src/installation/installer.test.ts`
- Modify: `packages/plugins/src/index.ts`
- Modify: `packages/core/src/config/paths.ts`
- Test: `packages/core/src/config/paths.test.ts`

**持久格式：**

```ts
interface InstalledPluginStoreV1 {
  schemaVersion: 1;
  revision: number;
  plugins: Record<string, InstalledPluginRecord>;
}

interface InstalledPluginRecord {
  id: string;
  scope: "user" | "project" | "local" | "managed";
  projectDir?: string;
  enabled: boolean;
  currentVersion: string;
  cachePath: string;
  origin: "native" | "converted";
  sourceFormat?: string;
  requestedPermissions: string[];
  approvedPermissions: string[];
  installedAt: string;
  updatedAt: string;
}
```

- [ ] **Step 1：写路径和 store round-trip 测试**

新增统一路径：

```text
getPluginCacheDir()
getPluginDataDir()
getPluginSourcesDir()
getInstalledPluginStorePath()
```

设置 `VYKOR_CONFIG_DIR` 时所有路径必须跟随测试目录。

- [ ] **Step 2：写原子 store 更新测试**

覆盖：默认空 store、版本拒绝、revision 增长、临时文件原子 rename、写失败保留旧 store、按 cwd 解析 user/project/local scope、managed 不可修改。

- [ ] **Step 3：写本地安装和权限批准失败测试**

流程应为：

```text
validate source native plugin
-> copy to unique temp cache
-> validate copied artifact
-> compute behavior digest
-> replace cache/<plugin-id>/current
-> update installed store
```

复制/校验/store 更新任一失败时 current record 不改变。

Native manifest 声明的权限必须规范化为稳定 permission key。安装请求没有批准全部 required permission 时返回 blocked，不能先安装为 enabled 再等待 Runtime 发现。批准结果写入 installed record，不写回插件 manifest。

- [ ] **Step 4：实现 cache 和 installer**

普通 install 复制；link 使用单独 record 类型或 `linkedSourcePath`，不得伪装成 cache copy。卸载默认保留 plugin data。

- [ ] **Step 5：实现只读发现**

```ts
export async function discoverInstalledNativePlugins(input: {
  cwd: string;
}): Promise<InstalledPluginResolution>;
```

Runtime 可以调用只读发现；只有 PluginService 调用 mutation API。

- [ ] **Step 6：运行检查**

```bash
pnpm --filter @vykor/core exec vitest run src/config/paths.test.ts
pnpm --filter @vykor/plugins exec vitest run src/installation
pnpm --filter @vykor/plugins check-types
```

- [ ] **Step 7：提交 installation slice**

建议提交：`feat(plugins): add native plugin installation store`

---

## Task 4：让 Agent Runtime 只激活 Native Plugin

**文件：**

- Create: `packages/plugins/src/activation/activate.ts`
- Create: `packages/plugins/src/activation/activate.test.ts`
- Modify: `packages/agent-runtime/src/extensions.ts`
- Modify: `packages/agent-runtime/src/extensions.test.ts`
- Modify: `packages/agent-runtime/src/agent-composition.ts`
- Test: `packages/agent-runtime/src/agent-composition.test.ts`（如已有对应测试则扩展）

**产出接口：**

```ts
export interface NativePluginActivationResult {
  pluginId: string;
  status: "active" | "partial" | "failed";
  activatedComponents: NativePluginComponentKind[];
  diagnostics: PluginDiagnostic[];
}

export async function activateNativePlugin(
  plugin: LoadedNativePlugin,
  context: NativePluginActivationContext,
): Promise<NativePluginActivationResult>;
```

- [ ] **Step 1：写两个 cwd 不串线的失败测试**

安装 user plugin 和两个 project/local plugin，分别创建 cwd A/B Runtime，断言 Skills、Agents、Hooks、MCP 只按 scope 出现。

- [ ] **Step 2：写 partial activation 和关闭测试**

MCP 连接失败不移除已注册 Skill，但 activation 为 partial；Runtime close 后 Hook 和 MCP 连接退出。当前 Tool component 只产生 unsupported，不 import 文件。

- [ ] **Step 3：运行失败测试**

```bash
pnpm --filter @vykor/plugins exec vitest run src/activation
pnpm --filter @vykor/agent-runtime exec vitest run src/extensions.test.ts
```

- [ ] **Step 4：改写 extension discovery**

`discoverVykorExtensions()` 改为：

```text
read installed store for cwd
-> validate current cache artifact
-> load Native Plugin
-> assemble static Skills/Agents/MCP definitions
```

`configureDiscoveredExtensions()` 只激活 Native Hook/MCP 等运行组件。

- [ ] **Step 5：删除旧 Tool import 路径**

删除 `extensions.ts` 中 `readdirSync(toolsPath)` 和动态 `import(filePath)`；增加测试证明声明 Tool 不会执行模块顶层代码。

- [ ] **Step 6：运行 Runtime 检查**

```bash
pnpm --filter @vykor/plugins test
pnpm --filter @vykor/agent-runtime exec vitest run src/extensions.test.ts src/agent-composition.test.ts
pnpm --filter @vykor/agent-runtime check-types
```

- [ ] **Step 7：提交 Runtime hard cut**

建议提交：`refactor(runtime): activate native plugins only`

---

## Task 5：改造 PluginService、HTTP 和 Client 公共契约

**文件：**

- Modify: `packages/server/src/application/settings-api.ts`
- Modify: `packages/server/src/application/default-services/plugin-service.ts`
- Test: `packages/server/src/application/__test__/default-application-services.test.ts`
- Modify: `packages/server/src/http/routes/service.ts`
- Test: `packages/server/src/http/routes/__test__/routes.test.ts`
- Test: `packages/server/src/http/__test__/http.test.ts`
- Modify: `packages/client/src/types/index.ts`
- Modify: `packages/client/src/transport/http-client.ts`
- Test: `packages/client/src/transport/__test__/http-client.test.ts`

**新公共类型：**

```ts
interface PluginInfo {
  identity: VykorPluginIdentity;
  origin: "native" | "converted";
  sourceFormat?: string;
  scope: PluginScope;
  enabled: boolean;
  installation: "installed" | "missing" | "invalid";
  activation: "inactive" | "active" | "partial" | "reload-required";
  inventory: Record<NativePluginComponentKind, number>;
  permissions: PluginPermissionSummary;
  conversion?: PluginConversionSummary;
  diagnostics: PluginDiagnostic[];
}
```

- [ ] **Step 1：写 service 失败测试**

覆盖：按 cwd 列出 scope、坏 artifact 不消失、按稳定 ID 启停、managed 拒绝修改、安装本地 Native Plugin、卸载保留 data、变更后返回 reload-required。

- [ ] **Step 2：写 HTTP/client 失败测试**

目标资源：

```text
GET    /plugins?cwd=
POST   /plugins/install-local
POST   /plugins/link-local
POST   /plugins/:id/enable
POST   /plugins/:id/disable
DELETE /plugins/:id
POST   /plugins/reload
```

ID 必须 URL encode；install/link body 明确 `cwd`、`sourcePath`、`scope`。

install/link body 同时携带用户明确批准的 `approvedPermissions`。Service 必须重新从已验证 manifest 计算 requested permissions，不能信任 Client 自报的 requested 列表；批准不足返回 400/blocked detail，批准未知 permission 返回 400。

- [ ] **Step 3：实现 PluginService 作为唯一写 owner**

所有 mutation 使用 global 或 cwd mutation barrier。安装完成后关闭受影响 Runtime；active run 时返回 409。不要再通过 `saveSettings()` 写 `settings.plugins`。

- [ ] **Step 4：实现 Client transport 和新类型**

删除只含 name/version/count 的旧 `PluginInfo`。Client 保留 `/plugin` 呈现所需完整诊断。

- [ ] **Step 5：运行 Server/Client 检查**

```bash
pnpm --filter @vykor/server exec vitest run src/application/__test__/default-application-services.test.ts src/http/routes/__test__/routes.test.ts src/http/__test__/http.test.ts
pnpm --filter @vykor/client exec vitest run src/transport/__test__/http-client.test.ts
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/client check-types
```

- [ ] **Step 6：提交 service contract**

建议提交：`feat(server): manage native plugin installations`

---

## Task 6：改造 CLI，并删除当前临时插件格式

**文件：**

- Modify: `apps/cli/src/commands/plugin.ts`
- Create/Modify tests: `apps/cli/src/commands/plugin.test.ts`
- Modify: `packages/client/src/commands/session-commands.ts`
- Modify: `packages/client/src/commands/__test__/session-commands.test.ts`
- Modify: `packages/core/src/types/settings.ts`
- Modify: `packages/core/src/config/settings.test.ts`
- Delete: `apps/cli/src/plugin-contributions.ts`
- Delete: `apps/cli/src/plugin-contributions.test.ts`
- Delete/replace old `packages/plugins/src/{discovery,contributions,hooks-mcp,agents}*`
- Rewrite: `packages/plugins/src/index.ts`
- Rewrite: `packages/plugins/README.md`

- [ ] **Step 1：写 CLI 目标行为测试**

```text
vk plugin list
vk plugin install-local <path> --scope user|project|local
vk plugin link <path> --scope user|project|local
vk plugin enable <id>
vk plugin disable <id>
vk plugin uninstall <id>
vk plugin validate <path>
vk plugin details <id>
```

安装/启停/卸载调用 daemon Client；`validate` 是本地只读操作。

含权限声明的 install/link 先展示 permission summary，并要求交互确认或显式 `--approve <permission>`；非交互环境缺少批准时失败，不使用隐式 `--yes` 扩大权限。

- [ ] **Step 2：修改 slash 输出**

`/plugin list` 展示 identity、origin、scope、compatibility/activation 和 diagnostics，不再只输出四个计数。enable/disable 接受稳定 ID。

- [ ] **Step 3：删除旧 settings 字段**

从 `Settings`、默认值、sanitize、runtime restart keys、测试和文档中删除：

```text
plugins
allowProjectPlugins
```

不保留读取别名；旧字段由 settings 严格校验策略按当前项目约定失败或忽略，具体行为必须与 `loadSettings` 现有未知字段契约一致并有测试。

- [ ] **Step 4：删除旧 loader/installer/CLI cache**

使用 `rg` 审计：

```bash
rg -n "enabled_by_default|skills_dir|tools_dir|hooks_file|mcp_file|allowProjectPlugins|registerPluginTools|loadPluginContributions|getLoadedPlugins" packages apps
```

生产结果必须为空；历史文档可以保留，但必须标明待替换/历史。

- [ ] **Step 5：运行核心回归**

```bash
pnpm --filter @vykor/plugins test
pnpm --filter @vykor/agent-runtime test
pnpm --filter @vykor/server test
pnpm --filter @vykor/client test
pnpm --filter @vykor/cli test
pnpm --filter @vykor/core check-types
pnpm --filter @vykor/cli check-types
```

- [ ] **Step 6：提交旧格式删除**

建议提交：`refactor(plugins): remove legacy plugin format`

### Native Plugin v1 Gate

进入 Converter 实施前必须满足：

1. Runtime 只加载 Native Plugin；
2. 本地 Native Plugin 可以 install/link/list/enable/disable/reload/uninstall；
3. Skills、Agents、Hooks 和 MCP 完成端到端激活；
4. `tools` recognized 但不会执行；
5. 旧 manifest 和旧 settings 字段已删除；
6. installed state、cache 和 data 所有权明确；
7. Server/Client/CLI 只使用稳定 plugin ID；
8. focused tests 和受影响 package typecheck 全部通过。

---

## Task 7：创建 `@vykor/plugin-converters` 和 Converter core

**文件：**

- Create: `packages/plugin-converters/package.json`
- Create: `packages/plugin-converters/tsconfig.json`
- Create: `packages/plugin-converters/src/core/converter.ts`
- Create: `packages/plugin-converters/src/core/registry.ts`
- Create: `packages/plugin-converters/src/core/registry.test.ts`
- Create: `packages/plugin-converters/src/core/plan.ts`
- Create: `packages/plugin-converters/src/core/report.ts`
- Create: `packages/plugin-converters/src/core/digest.ts`
- Create: `packages/plugin-converters/src/core/digest.test.ts`
- Create: `packages/plugin-converters/src/index.ts`
- Modify: `pnpm-lock.yaml`（仅 workspace link 产生真实变化时）

- [ ] **Step 1：写 registry 和歧义检测失败测试**

断言：零匹配、唯一匹配、多个高置信匹配要求 `--from`、显式 converter ID、detector 异常转诊断而不拖垮其他 detector。

- [ ] **Step 2：实现 SPI 和纯 registry**

Converter v1 只允许应用内建注册，不提供 Native Plugin 注册 Converter 的入口。

新 package 至少依赖 `@vykor/plugins` 的 Native schema/types 和 `zod`；不得依赖 `@vykor/agent-runtime`、Server 或应用包。`package.json`、`tsconfig.json` 和 workspace export 规则对齐现有 packages，并增加 `test`、`check-types`、`clean` scripts。

- [ ] **Step 3：写 plan 稳定性和 digest 测试**

相同 source、options 和 Converter 版本产生稳定排序 plan；`convertedAt` 和绝对 source path 不进入 behavior digest。

- [ ] **Step 4：实现 fidelity/report 类型**

实现 exact/adapted/unsupported/blocked 和最终 status 汇总。`blocked` 未批准时 `convert()` 必须拒绝。

- [ ] **Step 5：运行新包检查**

```bash
pnpm --filter @vykor/plugin-converters test
pnpm --filter @vykor/plugin-converters check-types
```

- [ ] **Step 6：提交 Converter core**

建议提交：`feat(plugin-converters): add conversion planning core`

---

## Task 8：实现 Claude Code source detection、inspection 和路径规则

**文件：**

- Create: `packages/plugin-converters/src/claude-code/detector.ts`
- Create: `packages/plugin-converters/src/claude-code/detector.test.ts`
- Create: `packages/plugin-converters/src/claude-code/parser.ts`
- Create: `packages/plugin-converters/src/claude-code/parser.test.ts`
- Create: `packages/plugin-converters/src/claude-code/source-paths.ts`
- Create fixtures under `packages/plugin-converters/fixtures/claude-code/`
- Modify: `packages/plugin-converters/src/index.ts`

- [ ] **Step 1：建立 Claude fixtures**

至少：标准 manifest、无 manifest 标准目录、根级 `SKILL.md`、自定义 paths、损坏 manifest、路径逃逸、未知组件、混合插件。

- [ ] **Step 2：写 detection 测试**

证据包括 `.claude-plugin/plugin.json`、标准 component、根级 `SKILL.md`。普通 Markdown 目录不能误判成插件。

- [ ] **Step 3：写 inspection 测试**

按 Claude 规则断言：manifest 可选；manifest 损坏不回退猜测；Skills custom path 追加；Commands/Agents custom path 替换默认；所有源路径留在 root；未知组件进入 inventory。

- [ ] **Step 4：实现只读 parser**

不得 import、spawn、fetch 或安装依赖。为此增加测试，在 fixture 放一个“若执行就写 sentinel”的 JS 文件，inspect 后 sentinel 不存在。

- [ ] **Step 5：运行检查**

```bash
pnpm --filter @vykor/plugin-converters exec vitest run src/claude-code/detector.test.ts src/claude-code/parser.test.ts
pnpm --filter @vykor/plugin-converters check-types
```

- [ ] **Step 6：提交 Claude inspection**

建议提交：`feat(plugin-converters): inspect claude code plugins`

---

## Task 9：转换 Claude Skills、Commands 和 Agents

**文件：**

- Create: `packages/plugin-converters/src/claude-code/convert-skills.ts`
- Create: `packages/plugin-converters/src/claude-code/convert-skills.test.ts`
- Create: `packages/plugin-converters/src/claude-code/convert-agents.ts`
- Create: `packages/plugin-converters/src/claude-code/convert-agents.test.ts`
- Create: `packages/plugin-converters/src/claude-code/mappings.ts`
- Modify fixtures as required

- [ ] **Step 1：写 Skill/Command plan 测试**

断言 namespace、frontmatter、资源复制、`sourceKind`、`$ARGUMENTS`、位置参数和用户不可调用字段。普通静态 Skill 应是 exact；需要变量 shim 时是 adapted。

- [ ] **Step 2：实现 Native 组件资源保留策略**

将已支持的组件直接写入 `skills/`、`agents/` 等 Native 目录；Skill 同目录资源随组件复制并保持相对关系。此步骤由 [2026-08-30 收口计划](./2026-08-30-native-plugin-conversion-simplification.md) 修订，不再复制完整 Claude `payload/`。

- [ ] **Step 3：写 Agent mapping 测试**

覆盖：`inherit/haiku/sonnet/opus`、具体模型 ID、Read/Write/Edit/Bash/Grep/Glob、unknown Tool、maxTurns、effort、skills、memory、background、worktree isolation，以及禁止字段 hooks/mcpServers/permissionMode。

- [ ] **Step 4：实现确定性 mapping**

mapping table 有独立语义版本，记录到 plan/provenance。未知模型回退策略必须由 conversion options 明确，不允许转换器自行选择当前机器模型后把结果伪装成 exact。

- [ ] **Step 5：运行检查**

```bash
pnpm --filter @vykor/plugin-converters exec vitest run src/claude-code/convert-skills.test.ts src/claude-code/convert-agents.test.ts
```

- [ ] **Step 6：提交 prompt components**

建议提交：`feat(plugin-converters): convert claude skills and agents`

---

## Task 10：转换 Claude Hooks、MCP 和环境兼容

**文件：**

- Create: `packages/plugin-converters/src/claude-code/convert-hooks.ts`
- Create: `packages/plugin-converters/src/claude-code/convert-hooks.test.ts`
- Create: `packages/plugin-converters/src/claude-code/convert-mcp.ts`
- Create: `packages/plugin-converters/src/claude-code/convert-mcp.test.ts`
- Create: `packages/plugin-converters/src/claude-code/environment.ts`
- Create: `packages/plugin-converters/src/claude-code/environment.test.ts`
- Modify: `packages/plugins/src/manifest/schema-v1.ts`
- Modify: `packages/plugins/src/activation/activate.ts`

- [ ] **Step 1：写 Hook 语义 mapping 测试**

至少覆盖 SessionStart、PreToolUse、PostToolUse、PostToolUseFailure、SessionEnd；每个 mapping 断言 source event、target event、matcher、stdin/stdout/exit-code policy 和 fidelity。无等价语义的事件必须 unsupported。

- [ ] **Step 2：写 MCP transport 测试**

```text
command -> stdio
url + http -> http
url + sse -> sse
url + ws -> ws
歧义字段 -> invalid
```

Converter 只生成配置，不连接 Server。

- [ ] **Step 3：写 Native 环境测试（由 2026-08-30 收口计划修订）**

转换后的插件只使用 Vykor Native 环境。`origin/sourceFormat` 不能触发 `CLAUDE_PLUGIN_ROOT`、`CLAUDE_PLUGIN_DATA` 或 `CLAUDE_PROJECT_DIR` 注入；无法转换的源脚本必须在 report 中标为 adapted/unsupported。

- [ ] **Step 4：实现 Hook/MCP/environment converter**

不使用全局字符串 replace 改写脚本；路径出现在声明字段时生成 Native 配置，无法转换的源格式变量进入诊断，不由 Runtime 提供 compatibility alias。

- [ ] **Step 5：运行 Converter 和 activation 测试**

```bash
pnpm --filter @vykor/plugin-converters exec vitest run src/claude-code/convert-hooks.test.ts src/claude-code/convert-mcp.test.ts src/claude-code/environment.test.ts
pnpm --filter @vykor/plugins exec vitest run src/activation
```

- [ ] **Step 6：提交 executable component conversion**

建议提交：`feat(plugin-converters): convert claude hooks and mcp`

---

## Task 11：物化完整转换产物，并接入 CLI convert/install

**文件：**

- Create: `packages/plugin-converters/src/claude-code/converter.ts`
- Create: `packages/plugin-converters/src/claude-code/converter.test.ts`
- Modify: `apps/cli/src/commands/plugin.ts`
- Modify/Create: `apps/cli/src/commands/plugin.test.ts`
- Modify: `packages/server/src/application/default-services/plugin-service.ts`
- Modify: `packages/client/src/transport/http-client.ts`

- [ ] **Step 1：写端到端 conversion fixture 测试**

对 mixed Claude fixture 执行：detect → inspect → plan → approve → convert，断言目标包含：

```text
.vykor-plugin/plugin.json
.vykor-conversion/provenance.json
.vykor-conversion/plan.json
.vykor-conversion/report.json
skills/
agents/
hooks.json
mcp.json
```

然后调用 `validateNativePlugin()`，必须 valid。

- [ ] **Step 2：写失败补偿测试**

转换中断、Native validation 失败、目标已存在、复制越界、blocked 未批准时，不留下被误认为成功的目标目录。临时目录在失败后清理或明确标记 incomplete。

- [ ] **Step 3：实现 `vk plugin convert`**

支持：

```text
--from
--output
--dry-run
--json
--approve <permission-or-component>
```

dry-run 不写文件；默认文本和 `--json` 使用同一 plan/report 数据。

- [ ] **Step 4：接入 converted install**

`vk plugin install --from claude-code <source>` 在本地生成临时转换产物，通过 Client 请求 daemon 安装该 Native Plugin。安装成功后清理临时目录；失败保留可诊断路径或复制 report 到安全临时位置，并在输出中说明。

Converter plan 中批准的权限必须与最终 Native manifest 重新计算的 requested permissions 一致；daemon 安装时再次校验并保存批准。CLI 不能仅凭本地 plan 绕过 PluginService 权限检查。

- [ ] **Step 5：实现 conversion summary**

PluginInfo 从 provenance/report 得到 origin/sourceFormat/converterVersion/status，不让 Runtime 重新读取 Claude source。

- [ ] **Step 6：运行端到端检查**

```bash
pnpm --filter @vykor/plugin-converters test
pnpm --filter @vykor/plugins test
pnpm --filter @vykor/server exec vitest run src/application/__test__/default-application-services.test.ts src/http/__test__/http.test.ts
pnpm --filter @vykor/client test
pnpm --filter @vykor/cli test
```

- [ ] **Step 7：提交完整转换链路**

建议提交：`feat(plugins): import claude plugins through converter`

---

## Task 12：安全、重转换、文档和仓库级验收

**文件：**

- Add/modify focused tests only as required by this task
- Modify: `README.md`
- Rewrite: `docs/plugins-contributions-design.md`
- Modify: `docs/slash-commands.md`
- Modify: `docs/slash-commands-flow.md`
- Modify: `docs/security-and-trust-boundaries.md`
- Modify: `docs/operations-and-recovery.md`
- Modify: `docs/contract-test-index.md`
- Modify: `PLAN-REMAINING.md` if it still tracks the old plugin format

- [ ] **Step 1：增加转换阶段禁止副作用测试**

fixture 包含若被执行就写 sentinel、联网或启动进程的脚本。detect/inspect/plan/convert 完成后断言没有 sentinel、没有 spawn/fetch 调用。使用 dependency injection/mock 证明，而不是依赖真实公网不可用。

- [ ] **Step 2：增加重新转换判断测试**

覆盖 source digest、Converter version、target schema、options digest、mapping semantic version 和 newly-supported component。任一行为变化返回 reconvert-required；只改变 `convertedAt` 不触发。

- [ ] **Step 3：增加原子升级回退测试**

新 conversion/validation/install 失败时 installed record 仍指向旧 cache；成功时 revision 增长并标记相关 Runtime reload-required。

- [ ] **Step 4：执行生产代码审计**

```bash
rg -n "enabled_by_default|skills_dir|tools_dir|hooks_file|mcp_file|allowProjectPlugins|loadPluginContributions|getLoadedPlugins|registerPluginTools" packages apps
rg -n "claude-plugin|ClaudePlugin|PostToolUse|CLAUDE_PLUGIN_ROOT" packages/agent-runtime packages/plugins
```

第一条生产代码无旧格式命中；第二条在 Runtime/Native loader 中无外部格式解析命中。`CLAUDE_*` 可以出现在通用 compatibility alias fixture/数据中，但不能形成 Claude parser 分支。

- [ ] **Step 5：更新当前文档**

把 `docs/plugins-contributions-design.md` 从“待替换的当前实现”改写为 Native Plugin 当前实现文档。README 不再声称沿用 Claude 目录或直接 import `tools_dir`。文档讲清：入口、转换、安装状态、cache/data、Runtime 激活和结果返回。

- [ ] **Step 6：运行完整验证**

```bash
pnpm --filter @vykor/plugins test
pnpm --filter @vykor/plugin-converters test
pnpm --filter @vykor/agent-runtime test
pnpm --filter @vykor/server test
pnpm --filter @vykor/client test
pnpm --filter @vykor/cli test
pnpm check-types
node scripts/check-docs.mjs
git diff --check
```

根 `turbo.json` 如果仍无 `lint` task，不把 `pnpm lint` 写成虚假的完成 gate；只对实际修改且存在 package-local lint 的包运行对应 lint。

- [ ] **Step 7：做本地人工验收**

路径 A：安装手写 Native Plugin。

```text
validate -> install -> list -> enable -> create Runtime
-> Skill/Agent/Hook/MCP 可见 -> disable/reload -> 能力退出
```

路径 B：转换 Claude Plugin。

```text
source inspect -> dry-run plan -> exact/adapted/unsupported 报告
-> convert -> native validate -> install -> Runtime 激活
```

路径 C：失败与回退。

```text
损坏 manifest / 路径逃逸 / blocked 未批准 / MCP 配置歧义
-> 明确诊断 -> 不更新 installed current -> 旧 Runtime/版本继续可用
```

- [ ] **Step 8：提交文档和最终收口**

建议提交：`docs(plugins): document native plugin conversion flow`

## 最终完成 Gate

本计划完成必须同时满足：

1. `.vykor-plugin/plugin.json` 是 Runtime 唯一插件 manifest。
2. `@vykor/plugins` 不解析 Claude/Codex 格式。
3. `@vykor/plugin-converters` 不依赖 Agent Runtime，也不执行 source plugin。
4. Native Skills、Agents、Hooks、MCP 完成安装到 Runtime 的闭环。
5. Native Tool 不再由 daemon 主进程动态 import；隔离实现前保持 unsupported/blocked。
6. 当前旧 schema、旧 Installer、旧 CLI cache、`Settings.plugins` 和 `allowProjectPlugins` 已删除。
7. PluginService 是 installed state 唯一生产写 owner。
8. Claude Code Converter 能生成通过 Native Validator 的完整 artifact。
9. Conversion plan/report/provenance 可查看，exact/adapted/unsupported/blocked 不丢失。
10. 源更新和 Converter/schema/mapping 变化能正确判断重新转换。
11. 转换或升级失败不会破坏当前已安装版本。
12. Runtime、Server、Client、CLI 不包含外部格式解析分支。
13. 定向测试、受影响包测试、workspace typecheck、文档检查和 diff 检查全部通过。

## 后续计划入口

本计划完成后再分别编写：

1. Native LSP、Output Styles、`bin/` 和隔离 Native Tool 计划；
2. Desktop Plugin/Conversion 管理页计划；
3. Marketplace、Git/npm/archive、依赖和组织策略计划；
4. Codex Converter 计划。

这些工作不能在本计划实施途中顺带加入，以免重新扩大第一轮格式硬切的风险面。

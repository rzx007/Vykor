# Native Plugin 重新安装核心实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 复用现有 Native ZIP 导入，把“重新导入同一插件”收口为可靠的更新/修复入口，同时保留启用状态并只在新增权限时再次确认。

**架构：** 不增加 Update 或 Repair 服务。Native Installer 负责继承现有安装记录的用户状态；Server Plugin Service 负责基于可信安装记录判断权限是否需要重新批准；Desktop 只消费 `approvalRequired` 并沿用现有安装、确认和结果反馈。

**技术栈：** TypeScript、Node.js 文件系统、Zod/Hono 现有 HTTP 路由、Electron IPC、React、Vitest。

---

## 文件结构

- 修改 `packages/plugins/src/installation/installer.ts`：替换同一用户插件时保留 `enabled` 和 `installedAt`。
- 修改 `packages/plugins/src/installation/installer.test.ts`：锁定重新安装的状态继承行为。
- 修改 `packages/server/src/application/settings-api.ts`：给 Archive preview 增加 `approvalRequired`。
- 修改 `packages/server/src/application/default-services/plugin-service.ts`：从安装记录计算权限覆盖关系，并在 install 时再次校验。
- 修改 `packages/server/src/application/default-services/plugin-service.test.ts`：覆盖权限复用、新增权限和失败不切换记录。
- 修改 `packages/client/src/types/index.ts`：同步 `PluginArchivePreview` 类型。
- 修改 `apps/desktop/src/main/features/plugin/plugin-service.ts`：根据 `approvalRequired` 决定直接安装还是进入现有确认流程。
- 修改 `apps/desktop/src/main/features/plugin/plugin-service.test.ts`：覆盖已批准权限的无感重新安装。
- 修改 `apps/desktop/src/renderer/src/components/desktop/plugin-page/plugin-manager.tsx`：成功文案兼容首次安装和重新安装。
- 修改 `apps/desktop/src/renderer/src/components/desktop/plugin-page/plugin-manager.test.tsx`：锁定简化后的成功反馈。
- 修改 `docs/native-plugin-authoring.md`、`docs/plugin-system-handoff.md`、`docs/plugins-contributions-design.md`：记录“重新导入即更新/修复”的当前能力和明确边界。

### 任务 1：Native Installer 保留用户状态

**文件：**
- 修改：`packages/plugins/src/installation/installer.ts`
- 测试：`packages/plugins/src/installation/installer.test.ts`

- [ ] **步骤 1：编写失败的安装器测试**

在 `installer.test.ts` 增加一个测试：先安装 fixture，再把记录设为禁用并保存首次安装时间，然后重新安装同一 ID，断言版本/快照可以更新，但 `enabled` 仍为 `false`，`installedAt` 不变，`updatedAt` 更新。

```ts
it("preserves enabled state and installedAt when reinstalling the same user plugin", async () => {
  const storePath = join(root, "installed.json");
  const first = await installLocalNativePlugin({
    sourcePath: fixture,
    scope: "user",
    cwd: root,
    approvedPermissions: [],
    cacheDir: join(root, "cache"),
    storePath,
  });
  expect(first.status).toBe("installed");
  if (first.status !== "installed") throw new Error("expected first install");

  await updateInstalledPluginStore(storePath, (store) => {
    const record = store.plugins["user::dev.vykor.minimal-skill"]!;
    record.enabled = false;
    record.installedAt = "2026-01-01T00:00:00.000Z";
    record.updatedAt = "2026-01-01T00:00:00.000Z";
  });

  const second = await installLocalNativePlugin({
    sourcePath: fixture,
    scope: "user",
    cwd: root,
    approvedPermissions: [],
    cacheDir: join(root, "cache"),
    storePath,
  });
  expect(second.status).toBe("installed");
  const record = (await readInstalledPluginStore(storePath)).plugins[
    "user::dev.vykor.minimal-skill"
  ]!;
  expect(record.enabled).toBe(false);
  expect(record.installedAt).toBe("2026-01-01T00:00:00.000Z");
  expect(record.updatedAt).not.toBe("2026-01-01T00:00:00.000Z");
});
```

同时从 `./store.js` 导入 `updateInstalledPluginStore`。测试中的 key 以 fixture manifest 的实际 ID 为准；若实际 ID 不同，直接使用 `first.record.id` 与 `installedPluginKey(first.record)` 构造，不硬编码猜测。

- [ ] **步骤 2：运行测试并确认现状失败**

运行：

```sh
pnpm --filter @vykor/plugins exec vitest run src/installation/installer.test.ts
```

预期：新增测试在 `enabled` 断言失败，当前重新安装会写回 `true`。

- [ ] **步骤 3：实现最小状态继承**

在更新 store 时，仅从同 key 的 previous 记录继承用户状态：

```ts
await updateInstalledPluginStore(input.storePath ?? getInstalledPluginStorePath(), (store) => {
  const key = installedPluginKey(record);
  const previous = store.plugins[key];
  store.plugins[key] = previous
    ? { ...record, enabled: previous.enabled, installedAt: previous.installedAt }
    : record;
});
```

不要继承旧版本、旧 cachePath、旧请求权限或旧批准集合。

- [ ] **步骤 4：运行安装器测试**

运行：

```sh
pnpm --filter @vykor/plugins exec vitest run src/installation/installer.test.ts
```

预期：该文件全部通过。

- [ ] **步骤 5：提交安装器改动**

```sh
git add packages/plugins/src/installation/installer.ts packages/plugins/src/installation/installer.test.ts
git commit -m "fix(plugins): preserve state on reinstall"
```

### 任务 2：Server 只在新增权限时要求确认

**文件：**
- 修改：`packages/server/src/application/settings-api.ts`
- 修改：`packages/server/src/application/default-services/plugin-service.ts`
- 测试：`packages/server/src/application/default-services/plugin-service.test.ts`
- 修改：`packages/client/src/types/index.ts`

- [ ] **步骤 1：编写失败的 Server 测试**

先在测试文件增加权限 manifest helper：

```ts
function permissionManifest(version: string, includeNetwork = false): string {
  return JSON.stringify({
    schemaVersion: 1,
    id: "dev.vykor.archive",
    name: "archive",
    version,
    permissions: {
      process: ["spawn"],
      ...(includeNetwork ? { network: ["api.example.com"] } : {}),
    },
    components: {
      tools: [{ entry: "./tools/not-executed.js", permissions: ["process.spawn"] }],
    },
  });
}
```

然后增加三个明确场景：

```ts
it("reuses previous approval when reinstalling with the same permissions", async () => {
  const archive = await writeNativeArchive("same-permissions.zip", {
    ".vykor-plugin/plugin.json": permissionManifest("1.0.0"),
  });
  const plugins = service() as any;
  const firstPreview = await plugins.previewArchive({ cwd: "C:/workspace", archivePath: archive });
  expect(firstPreview.approvalRequired).toBe(true);
  await plugins.installArchive({
    cwd: "C:/workspace",
    archivePath: archive,
    expectedArchiveDigest: firstPreview.archiveDigest,
    approvedPermissions: firstPreview.requestedPermissions,
  });

  const secondPreview = await plugins.previewArchive({ cwd: "C:/workspace", archivePath: archive });
  expect(secondPreview.approvalRequired).toBe(false);
  await expect(plugins.installArchive({
    cwd: "C:/workspace",
    archivePath: archive,
    expectedArchiveDigest: secondPreview.archiveDigest,
    approvedPermissions: [],
  })).resolves.toMatchObject({ message: "Installed plugin 'dev.vykor.archive'." });
});

it("requires approval when a reinstall adds a permission", async () => {
  const first = await writeNativeArchive("add-permission.zip", {
    ".vykor-plugin/plugin.json": permissionManifest("1.0.0"),
  });
  const plugins = service() as any;
  const firstPreview = await plugins.previewArchive({ cwd: "C:/workspace", archivePath: first });
  await plugins.installArchive({
    cwd: "C:/workspace",
    archivePath: first,
    expectedArchiveDigest: firstPreview.archiveDigest,
    approvedPermissions: firstPreview.requestedPermissions,
  });

  await writeNativeArchive("add-permission.zip", {
    ".vykor-plugin/plugin.json": permissionManifest("1.1.0", true),
  });
  const nextPreview = await plugins.previewArchive({ cwd: "C:/workspace", archivePath: first });
  expect(nextPreview.approvalRequired).toBe(true);
  await expect(plugins.installArchive({
    cwd: "C:/workspace",
    archivePath: first,
    expectedArchiveDigest: nextPreview.archiveDigest,
    approvedPermissions: [],
  })).rejects.toSatisfy(
    (error: unknown) => archiveFailureCode(error) === "plugin_archive_permissions_not_approved",
  );
});

it("keeps the previous record when reinstalling fails before the store switch", async () => {
  const archive = await writeNativeArchive("failed-reinstall.zip");
  const plugins = service() as any;
  const firstPreview = await plugins.previewArchive({ cwd: "C:/workspace", archivePath: archive });
  await plugins.installArchive({
    cwd: "C:/workspace",
    archivePath: archive,
    expectedArchiveDigest: firstPreview.archiveDigest,
    approvedPermissions: [],
  });
  const previous = Object.values(
    (await readInstalledPluginStore(getInstalledPluginStorePath())).plugins,
  )[0]!;

  const nextPreview = await plugins.previewArchive({ cwd: "C:/workspace", archivePath: archive });
  await writeNativeArchive("failed-reinstall.zip", {
    "tools/not-executed.js": "export default 'digest drift';",
  });
  await expect(plugins.installArchive({
    cwd: "C:/workspace",
    archivePath: archive,
    expectedArchiveDigest: nextPreview.archiveDigest,
    approvedPermissions: [],
  })).rejects.toSatisfy(
    (error: unknown) => archiveFailureCode(error) === "plugin_archive_changed",
  );
  const current = Object.values(
    (await readInstalledPluginStore(getInstalledPluginStorePath())).plugins,
  )[0]!;
  expect(current).toEqual(previous);
});
```

再增加一个“之前批准 process + network，本次只请求 process”的用例，使用 `permissionManifest("1.1.0")` 覆盖原 ZIP；断言 preview 的 `approvalRequired` 为 `false`，安装后 record 的 `approvedPermissions` 不再包含 network。

同时把现有 preview 断言补成：

```ts
expect(preview).toMatchObject({ approvalRequired: false });
```

首次导入且请求权限的现有测试补成：

```ts
expect(preview.approvalRequired).toBe(true);
```

- [ ] **步骤 2：运行 Server 测试并确认失败**

运行：

```sh
pnpm --filter @vykor/server exec vitest run src/application/default-services/plugin-service.test.ts
```

预期：`approvalRequired` 不存在，且已批准插件用空数组重新安装仍被拒绝。

- [ ] **步骤 3：增加共享类型字段**

在 Server 与 Client 的 `PluginArchivePreview` 中加入必填布尔值：

```ts
export interface PluginArchivePreview {
  archiveDigest: string;
  identity: { id: string; name: string; version: string; displayName?: string };
  requestedPermissions: string[];
  approvalRequired: boolean;
  inventory: Record<string, number>;
  diagnostics: PluginInfo["diagnostics"];
}
```

- [ ] **步骤 4：实现权限覆盖判断**

在 `plugin-service.ts` 添加只处理集合关系的小函数，并明确只读取 user 记录：

```ts
function findUserPluginRecord(
  store: Awaited<ReturnType<typeof readInstalledPluginStore>>,
  pluginId: string,
) {
  return Object.values(store.plugins).find(
    (record) => record.scope === "user" && record.id === pluginId,
  );
}

function permissionsCovered(requested: string[], approved: string[]): boolean {
  const approvedSet = new Set(approved);
  return requested.every((permission) => approvedSet.has(permission));
}

function permissionSetsEqual(left: string[], right: string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((permission, index) => permission === normalizedRight[index]);
}
```

让 `inspectArchive` 在 Native 校验得到插件 ID 后读取 store、查找 previous，并在同一个返回对象中计算 `approvalRequired`：

```ts
const store = await readInstalledPluginStore(getInstalledPluginStorePath());
const previous = findUserPluginRecord(store, validation.plugin.manifest.id);
const requestedPermissions = requestedPluginPermissions(validation.plugin.manifest);
return {
  archiveDigest: resolved.archiveDigest,
  identity,
  requestedPermissions,
  approvalRequired:
    requestedPermissions.length > 0 &&
    !permissionsCovered(requestedPermissions, previous?.approvedPermissions ?? []),
  inventory,
  diagnostics,
};
```

- [ ] **步骤 5：在 install 时重新判断并收紧有效批准**

安装请求再次读取 store。规则为：客户端提交的权限与本次请求完全相同时直接接受；否则仅当客户端提交空数组且 previous.approvedPermissions 覆盖本次请求时复用。传给 Native Installer 的永远是本次 `requestedPermissions`，不是旧的超集。

```ts
const previous = findUserPluginRecord(store, preview.identity.id);
const submitted = [...new Set(approvedPermissions)].sort();
const explicitlyApproved = permissionSetsEqual(submitted, preview.requestedPermissions);
const reusedApproval = submitted.length === 0 && permissionsCovered(
  preview.requestedPermissions,
  previous?.approvedPermissions ?? [],
);
if (!explicitlyApproved && !reusedApproval) {
  assertExactPermissionSet(preview.requestedPermissions, submitted);
}
const effectiveApprovals = [...preview.requestedPermissions];
```

随后把 `effectiveApprovals` 传给 `installLocalNativePlugin`。保留 managed 冲突检查，并保证它仍发生在安装记录写入前。

- [ ] **步骤 6：运行 Server 和 Client 类型检查**

运行：

```sh
pnpm --filter @vykor/server exec vitest run src/application/default-services/plugin-service.test.ts
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/client check-types
```

预期：测试及类型检查全部通过。

- [ ] **步骤 7：提交 Server 与类型改动**

```sh
git add packages/server/src/application/settings-api.ts packages/server/src/application/default-services/plugin-service.ts packages/server/src/application/default-services/plugin-service.test.ts packages/client/src/types/index.ts
git commit -m "feat(plugins): reuse approvals on reinstall"
```

### 任务 3：Desktop 沿用现有交互并更新文档

**文件：**
- 修改：`apps/desktop/src/main/features/plugin/plugin-service.ts`
- 测试：`apps/desktop/src/main/features/plugin/plugin-service.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/plugin-page/plugin-manager.tsx`
- 测试：`apps/desktop/src/renderer/src/components/desktop/plugin-page/plugin-manager.test.tsx`
- 修改：`docs/native-plugin-authoring.md`
- 修改：`docs/plugin-system-handoff.md`
- 修改：`docs/plugins-contributions-design.md`

- [ ] **步骤 1：编写失败的 Desktop main 测试**

给默认 preview fixture 补 `approvalRequired`，并增加已批准权限无感重新安装测试：

```ts
it("reinstalls immediately when the server says existing approval covers permissions", async () => {
  daemon.previewPluginArchive.mockResolvedValue({
    archiveDigest: "d".repeat(64),
    identity: { id: "archive-plugin", name: "Archive Plugin", version: "1.1.0" },
    requestedPermissions: ["process:spawn"],
    approvalRequired: false,
    inventory: {},
    diagnostics: [],
  });
  const service = new DesktopPluginService({
    chooseArchive: async () => "C:/private/plugin.zip",
  });

  await expect(
    (service as any).importArchive({} as never, { cwd: "C:/workspace" }),
  ).resolves.toMatchObject({ status: "installed", pluginName: "Archive Plugin" });
  expect(daemon.installPluginArchive).toHaveBeenCalledWith({
    cwd: resolve("C:/workspace"),
    archivePath: "C:/private/plugin.zip",
    expectedArchiveDigest: "d".repeat(64),
    approvedPermissions: [],
  });
});
```

现有需要权限确认的 fixture 明确设置 `approvalRequired: true`。

- [ ] **步骤 2：运行 Desktop main 测试并确认失败**

运行：

```sh
pnpm --filter @vykor/desktop exec vitest run src/main/features/plugin/plugin-service.test.ts
```

预期：当前代码仍按 `requestedPermissions.length` 弹确认，新增测试失败。

- [ ] **步骤 3：按 Server 判断结果选择现有路径**

把直接安装条件从权限数组长度改为可信 preview 字段：

```ts
if (!preview.approvalRequired) {
  try {
    await this.installArchive(cwd, archivePath, preview.archiveDigest, []);
  } catch (error) {
    if (isConnectionFailure(error)) return unknownInstallResult(pluginName);
    return archiveFailureFromError(error);
  }
  return await this.installedResult(cwd, pluginName);
}
```

权限确认卡继续展示完整的 `requestedPermissions`，不增加权限差异 UI。

- [ ] **步骤 4：更新成功反馈及测试**

Renderer 的两个成功分支统一改为兼容首次安装和重新安装的简短文案：

```ts
result.snapshot
  ? `${result.pluginName} 已安装或更新，将在下次对话中生效。`
  : `${result.pluginName} 已安装或更新，将在下次对话中生效。插件列表可刷新。`
```

更新对应测试的精确字符串断言。失败和 unknown 文案保持不变。

- [ ] **步骤 5：运行 Desktop 窄范围测试和 node typecheck**

运行：

```sh
pnpm --filter @vykor/desktop exec vitest run src/main/features/plugin/plugin-service.test.ts src/renderer/src/components/desktop/plugin-page/plugin-manager.test.tsx
pnpm --filter @vykor/desktop exec tsc --noEmit -p tsconfig.node.json --composite false
```

预期：测试及 node TypeScript 检查通过。

- [ ] **步骤 6：更新当前文档**

三份文档使用同一组明确表述：

```text
Desktop 重新导入同一插件 ID 的 Native ZIP，即执行更新或修复。系统仅在新增权限时再次确认；成功切换前保留旧安装记录，重新安装不会自动启用原本已禁用的插件。当前没有自动更新、独立 Repair 命令、版本回滚或旧快照垃圾回收界面。
```

在 `docs/plugin-system-handoff.md` 的已完成项加入该能力，并从“未实现”描述中只移除与本阶段实际完成冲突的部分；不要把完整更新、来源刷新或垃圾回收标为完成。

- [ ] **步骤 7：提交 Desktop 与文档改动**

```sh
git add apps/desktop/src/main/features/plugin/plugin-service.ts apps/desktop/src/main/features/plugin/plugin-service.test.ts apps/desktop/src/renderer/src/components/desktop/plugin-page/plugin-manager.tsx apps/desktop/src/renderer/src/components/desktop/plugin-page/plugin-manager.test.tsx docs/native-plugin-authoring.md docs/plugin-system-handoff.md docs/plugins-contributions-design.md
git commit -m "feat(desktop): support safe plugin reinstall"
```

### 任务 4：阶段核验与自审

**文件：**
- 检查：本计划涉及的全部代码和文档

- [ ] **步骤 1：运行聚焦验证**

```sh
pnpm --filter @vykor/plugins exec vitest run src/installation/installer.test.ts
pnpm --filter @vykor/server exec vitest run src/application/default-services/plugin-service.test.ts
pnpm --filter @vykor/desktop exec vitest run src/main/features/plugin/plugin-service.test.ts src/renderer/src/components/desktop/plugin-page/plugin-manager.test.tsx
pnpm --filter @vykor/plugins check-types
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/client check-types
pnpm --filter @vykor/desktop exec tsc --noEmit -p tsconfig.node.json --composite false
```

预期：所有命令退出码为 0。

- [ ] **步骤 2：审查差异**

```sh
git diff origin/main...HEAD --check
git diff --stat origin/main...HEAD
git status --short
```

确认只有本计划列出的文件发生变化；没有自动更新、回滚、Repair API、ZIP 持久化或垃圾回收实现。

- [ ] **步骤 3：请求代码审查并处理阻断项**

使用 `requesting-code-review` 检查权限复用是否可绕过、失败路径是否改写旧记录、Desktop 是否误把请求权限为空当成批准。只修复与本阶段有关的阻断项。

- [ ] **步骤 4：完成最终验证提交**

若自审或代码审查产生修复：

```sh
git add packages/plugins/src/installation/installer.ts packages/plugins/src/installation/installer.test.ts packages/server/src/application/settings-api.ts packages/server/src/application/default-services/plugin-service.ts packages/server/src/application/default-services/plugin-service.test.ts packages/client/src/types/index.ts apps/desktop/src/main/features/plugin/plugin-service.ts apps/desktop/src/main/features/plugin/plugin-service.test.ts apps/desktop/src/renderer/src/components/desktop/plugin-page/plugin-manager.tsx apps/desktop/src/renderer/src/components/desktop/plugin-page/plugin-manager.test.tsx docs/native-plugin-authoring.md docs/plugin-system-handoff.md docs/plugins-contributions-design.md
git commit -m "fix(plugins): harden reinstall flow"
```

若没有修复，不创建空提交。

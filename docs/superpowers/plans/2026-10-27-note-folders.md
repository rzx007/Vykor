# 便签统一桌面与文件夹分类实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将便签页改为统一桌面，并用可持久化的单层文件夹、自动网格排序和连续拖拽开合交互替代“桌面／收纳”双模式。

**架构：** 便签正文继续由 `NoteRepository` 保存为 Markdown；新增 `NoteOrganizationRepository` 在同一 `notes/` 目录原子维护 `organization.json`。服务端以完整组织快照和基线哈希提供条件写入，桌面端用独立组织控制器做乐观更新与回滚；一个 dnd-kit 上下文负责桌面和展开文件夹，Motion 只负责非拖拽项的布局和开合动画。

**技术栈：** TypeScript、React 19、Electron、Hono、Vitest、dnd-kit、Motion、Node.js 文件 API、pnpm。

---

## 文件结构

### 新建

- `packages/services/src/notes/note-organization.ts`：组织数据类型、解析、对账、变换与确定性排序规则。
- `packages/services/src/notes/note-organization-repository.ts`：`organization.json` 的原子读写、哈希基线、串行写队列、冲突和损坏恢复。
- `packages/services/src/notes/__test__/note-organization.test.ts`：纯模型的合并、移入、移出、解散和对账测试。
- `packages/services/src/notes/__test__/note-organization-repository.test.ts`：文件落盘、冲突、未知版本、损坏副本和轮换文件测试。
- `apps/desktop/src/renderer/src/components/desktop/notes-page/note-organization.ts`：渲染端组织快照适配、搜索结果和置顶分区模型。
- `apps/desktop/src/renderer/src/components/desktop/notes-page/use-note-organization.ts`：读取、保存、乐观更新、失败回滚和刷新组织数据。
- `apps/desktop/src/renderer/src/components/desktop/notes-page/note-board.tsx`：统一网格、单一 `DndContext`、传感器、碰撞策略和拖拽浮层。
- `apps/desktop/src/renderer/src/components/desktop/notes-page/note-folder.tsx`：文件夹封面、菜单、原位展开、焦点恢复和夹内网格。
- `apps/desktop/src/renderer/src/components/desktop/notes-page/note-drag-state.ts`：6 px、250 ms、400 ms、24 px 阈值和拖拽意图状态机。
- `apps/desktop/src/renderer/src/components/desktop/notes-page/__test__/note-organization.test.ts`：搜索、置顶区和渲染顺序测试。
- `apps/desktop/src/renderer/src/components/desktop/notes-page/__test__/note-drag-state.test.ts`：固定阈值、计时清零、合并和拖出判定测试。
- `apps/desktop/src/renderer/src/components/desktop/notes-page/__test__/note-board.test.tsx`：键盘、取消、跨容器、自动开合和播报测试。

### 修改

- `packages/domain-contracts/src/notes/records.ts`、`packages/domain-contracts/src/notes/validation.ts`、`packages/domain-contracts/src/notes/index.ts`：公开组织快照、保存输入和验证。
- `packages/protocol/src/knowledge/notes.ts`、`packages/protocol/src/knowledge/__test__/notes.test.ts`：协议解析与非法结构测试。
- `packages/services/src/notes/index.ts`、`packages/services/src/notes/README.md`：导出组织仓库并记录状态归属。
- `packages/services/src/notes/note-repository.ts`、`packages/services/src/notes/__test__/markdown-note-repository.test.ts`：挂载组织仓库，删除正文后对账，并让备份包含组织文件。
- `packages/server/src/application/notes/note-application-service.ts`、同目录 `__test__/note-application-service.test.ts`：组织读取与条件保存用例、就绪准入和冲突映射。
- `packages/server/src/http/routes/notes.ts`、`packages/server/src/http/routes/__test__/notes.test.ts`：增加 `/notes/organization` GET/PUT。
- `packages/client/src/resources/workspace/note-resource.ts`：增加组织读取与保存客户端方法。
- `packages/server/src/application/backup/application-backup.ts`、同目录 `__test__/application-backup.test.ts`：备份、验证和恢复 `organization.json`，保持旧备份兼容。
- `apps/desktop/package.json`、`pnpm-lock.yaml`：声明 dnd-kit 直接依赖。
- `apps/desktop/src/shared/note-types.ts`、`desktop-api-contract.ts`、`ipc-channels.ts`：桌面组织类型和 IPC 契约。
- `apps/desktop/src/main/features/notes/note-service.ts`、`ipc.ts` 及其测试：桥接组织 API。
- `apps/desktop/src/preload/desktop-api.ts`、`desktop-api.test.ts`：暴露组织读取与保存。
- `apps/desktop/src/renderer/src/components/desktop/notes-page/use-notes-controller.ts`：正文控制器不再按更新时间决定最终渲染顺序，并把已保存便签交给组织控制器。
- `apps/desktop/src/renderer/src/components/desktop/notes-page/note-list.tsx`：拆出可复用便签纸片，移除旧 `ProjectFolderItem` 耦合。
- `apps/desktop/src/renderer/src/components/desktop/notes-page/notes-page.tsx`：删除模式切换和总收纳夹，接入 `NoteBoard`。
- `apps/desktop/src/renderer/src/components/desktop/notes-page/__test__/notes-page.test.tsx`、`use-notes-controller.test.tsx`：更新页面和控制器行为断言。
- `apps/desktop/src/renderer/src/components/desktop/notes-page/README.md`：说明入口、状态归属、拖拽流程和新增文件放置。

## 任务 1：定义组织模型与确定性变换

**文件：**
- 创建：`packages/services/src/notes/note-organization.ts`
- 创建：`packages/services/src/notes/__test__/note-organization.test.ts`
- 修改：`packages/services/src/notes/index.ts`

- [ ] **步骤 1：编写失败的模型测试**

覆盖：默认桌面、A 拖到 B 后文件夹占据 B 的索引、移入文件夹、拖出后只剩一张自动解散、删除文件夹按夹内顺序展开、重复引用只保留第一次、新 Markdown 追加桌面末尾。

```ts
it("creates a folder at the target note position", () => {
  const current = organizationOf("a", "b", "c");
  const next = mergeNotes(current, {
    activeNoteId: "a",
    targetNoteId: "b",
    folderId: "f1",
    folderName: "周会要点",
    now: 10,
  });
  expect(next.desktop).toEqual([
    { type: "folder", id: "f1" },
    { type: "note", id: "c" },
  ]);
  expect(next.folderItems.f1).toEqual(["b", "a"]);
});

it("dissolves a folder when one note remains", () => {
  const next = moveNoteToDesktop(folderWith("f1", ["a", "b"]), {
    noteId: "a",
    desktopIndex: 1,
  });
  expect(next.folders.f1).toBeUndefined();
  expect(next.folderItems.f1).toBeUndefined();
  expect(locations(next)).toEqual({ a: "desktop", b: "desktop" });
});
```

- [ ] **步骤 2：运行测试并确认因模块不存在而失败**

运行：

```powershell
pnpm --filter @vykor/services exec vitest run src/notes/__test__/note-organization.test.ts
```

预期：FAIL，无法导入 `note-organization` 或找不到导出函数。

- [ ] **步骤 3：实现最小组织模型**

定义 `NoteOrganizationV1`、`DesktopItem`、`NoteFolderRecord`，实现：

```ts
export const NOTE_ORGANIZATION_VERSION = 1;
export function reconcileOrganization(
  input: unknown,
  noteIds: readonly string[],
): ReconcileResult;
export function reorderInContainer(...): NoteOrganizationV1;
export function mergeNotes(...): NoteOrganizationV1;
export function moveNoteToFolder(...): NoteOrganizationV1;
export function moveNoteToDesktop(...): NoteOrganizationV1;
export function dissolveFolder(...): NoteOrganizationV1;
```

所有变换先 clone，完成后统一调用 `assertOrganizationInvariants`，禁止空文件夹、单便签文件夹、多归属、未知引用和文件夹嵌套。

- [ ] **步骤 4：运行模型测试并确认通过**

运行上一条 Vitest 命令。预期：PASS。

- [ ] **步骤 5：提交模型**

```powershell
git add -- 'packages/services/src/notes/note-organization.ts' 'packages/services/src/notes/__test__/note-organization.test.ts' 'packages/services/src/notes/index.ts'
git commit -m 'feat(notes): add folder organization model'
```

## 任务 2：实现 `organization.json` 安全仓库

**文件：**
- 创建：`packages/services/src/notes/note-organization-repository.ts`
- 创建：`packages/services/src/notes/__test__/note-organization-repository.test.ts`
- 修改：`packages/services/src/notes/markdown-note-files.ts`
- 修改：`packages/services/src/notes/note-repository.ts`
- 修改：`packages/services/src/notes/index.ts`
- 修改：`packages/services/src/notes/README.md`

- [ ] **步骤 1：编写失败的文件仓库测试**

测试必须覆盖：首次读取创建默认快照；UTF-8 原子替换；成功保存更新基线；旧哈希保存抛 `NoteOrganizationConflictError`；未来版本只读且原文件不变；损坏 JSON 产生不覆盖的时间戳副本；写入前生成 `organization.previous.json`；连续保存不会把自身写入误判为冲突。

```ts
it("rejects a stale baseline without replacing external contents", async () => {
  const first = repository.read(["a", "b"]);
  writeFileSync(repository.path, externalJson, "utf8");
  await expect(repository.save(first.organization, first.etag)).rejects.toBeInstanceOf(
    NoteOrganizationConflictError,
  );
  expect(readFileSync(repository.path, "utf8")).toBe(externalJson);
});

it("keeps a future version read-only", () => {
  writeFileSync(repository.path, '{"version":2}', "utf8");
  const result = repository.read(["a", "b"]);
  expect(result.readOnly).toBe(true);
  expect(result.warning).toContain("升级应用");
  expect(readdirSync(repository.directory)).not.toContain("organization.corrupt.json");
});
```

- [ ] **步骤 2：运行仓库测试并确认失败**

运行：

```powershell
pnpm --filter @vykor/services exec vitest run src/notes/__test__/note-organization-repository.test.ts
```

预期：FAIL，仓库类和冲突错误尚不存在。

- [ ] **步骤 3：实现安全读写和串行队列**

复用 `markdown-note-files.ts` 的普通文件、防符号链接、临时文件、`fsync`、`rename` 和清理逻辑，抽出不限制 Markdown 长度语义的 UTF-8 原子替换辅助函数。实现：

```ts
export interface NoteOrganizationSnapshot {
  organization: NoteOrganizationV1;
  etag: string;
  warning?: string;
  readOnly: boolean;
}

export class NoteOrganizationRepository {
  readonly path: string;
  read(noteIds: readonly string[]): NoteOrganizationSnapshot;
  save(
    organization: NoteOrganizationV1,
    expectedEtag: string,
    noteIds: readonly string[],
  ): Promise<NoteOrganizationSnapshot>;
}
```

`save` 在进程内队列中执行，锁内重读并比较 `etag`，成功后更新内存基线；保存前写 `organization.previous.json`。明确注释：轮换文件只保护校验时版本，不保证跨进程竞态窗口内的新外部写入。

`NoteRepository` 构造时创建组织仓库；删除 Markdown 成功后触发组织对账保存。组织保存失败不得撤销正文删除，但必须让上层收到组织警告并在下一次读取时继续对账。

- [ ] **步骤 4：运行仓库与 Markdown 回归测试**

```powershell
pnpm --filter @vykor/services exec vitest run src/notes/__test__/note-organization-repository.test.ts src/notes/__test__/markdown-note-repository.test.ts
```

预期：PASS。

- [ ] **步骤 5：提交文件仓库**

```powershell
git add -- 'packages/services/src/notes'
git commit -m 'feat(notes): persist folder organization beside markdown'
```

## 任务 3：公开协议、应用用例和 HTTP API

**文件：**
- 修改：`packages/domain-contracts/src/notes/records.ts`
- 修改：`packages/domain-contracts/src/notes/validation.ts`
- 修改：`packages/domain-contracts/src/notes/index.ts`
- 修改：`packages/protocol/src/knowledge/notes.ts`
- 修改：`packages/protocol/src/knowledge/__test__/notes.test.ts`
- 修改：`packages/server/src/application/notes/note-application-service.ts`
- 修改：`packages/server/src/application/notes/__test__/note-application-service.test.ts`
- 修改：`packages/server/src/http/routes/notes.ts`
- 修改：`packages/server/src/http/routes/__test__/notes.test.ts`
- 修改：`packages/client/src/resources/workspace/note-resource.ts`

- [ ] **步骤 1：编写失败的协议与路由测试**

增加 `GET /notes/organization` 和 `PUT /notes/organization`。PUT 输入必须同时包含完整 `organization` 和 `expectedEtag`；冲突返回 409，未来版本只读返回 409，非法多归属或单便签文件夹在到达仓库前返回 400。

```ts
it("conditionally replaces note organization", async () => {
  const saveOrganization = vi.fn(() => savedSnapshot);
  const response = await app.request("/organization", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organization, expectedEtag: "etag-1" }),
  });
  expect(response.status).toBe(200);
  expect(saveOrganization).toHaveBeenCalledWith(organization, "etag-1");
});
```

- [ ] **步骤 2：运行定向测试并确认失败**

```powershell
pnpm --filter @vykor/protocol exec vitest run src/knowledge/__test__/notes.test.ts
pnpm --filter @vykor/server exec vitest run src/application/notes/__test__/note-application-service.test.ts src/http/routes/__test__/notes.test.ts
```

预期：FAIL，缺少组织协议和路由。

- [ ] **步骤 3：实现契约和用例**

新增公开类型：

```ts
export interface NoteOrganizationSnapshotRecord {
  organization: NoteOrganizationV1Record;
  etag: string;
  readOnly: boolean;
  warning?: string;
}
export interface SaveNoteOrganizationInput {
  organization: NoteOrganizationV1Record;
  expectedEtag: string;
}
```

验证器必须限制名称长度、ID 格式、数组数量和重复 ID，防止任意大 JSON。应用服务将组织冲突映射为稳定 409，并复用现有 readiness 写准入。客户端增加：

```ts
organization(): Promise<NoteOrganizationSnapshotRecord>;
saveOrganization(input: SaveNoteOrganizationInput): Promise<NoteOrganizationSnapshotRecord>;
```

- [ ] **步骤 4：运行协议、应用、路由和客户端类型检查**

```powershell
pnpm --filter @vykor/protocol exec vitest run src/knowledge/__test__/notes.test.ts
pnpm --filter @vykor/server exec vitest run src/application/notes/__test__/note-application-service.test.ts src/http/routes/__test__/notes.test.ts
pnpm --filter @rzx/client check-types
```

预期：全部 PASS。

- [ ] **步骤 5：提交 API**

```powershell
git add -- 'packages/domain-contracts/src/notes' 'packages/protocol/src/knowledge' 'packages/server/src/application/notes' 'packages/server/src/http/routes/notes.ts' 'packages/server/src/http/routes/__test__/notes.test.ts' 'packages/client/src/resources/workspace/note-resource.ts'
git commit -m 'feat(notes): expose folder organization api'
```

## 任务 4：让备份与恢复携带组织文件

**文件：**
- 修改：`packages/services/src/notes/note-repository.ts`
- 修改：`packages/services/src/notes/__test__/markdown-note-repository.test.ts`
- 修改：`packages/server/src/application/backup/application-backup.ts`
- 修改：`packages/server/src/application/backup/__test__/application-backup.test.ts`

- [ ] **步骤 1：扩充失败的备份恢复测试**

在现有“backs up and restores global notes”测试中先保存含文件夹的组织快照，然后断言备份和恢复目录都包含相同的 `organization.json`。增加旧版本或没有组织文件的版本 3 备份测试，恢复后首次读取应生成默认桌面；未来版本组织文件必须让备份校验失败而不是被重建。

```ts
expect(
  JSON.parse(readFileSync(join(backupPath, "notes", "organization.json"), "utf8")),
).toMatchObject({ version: 1, folderItems: { f1: ["a", "b"] } });
```

- [ ] **步骤 2：运行备份测试并确认失败**

```powershell
pnpm --filter @vykor/server exec vitest run src/application/backup/__test__/application-backup.test.ts
```

预期：FAIL，`backupTo` 当前只复制 `.md`，`validateFiles` 不校验组织文件。

- [ ] **步骤 3：实现备份、校验与恢复兼容**

`backupTo` 在正文文件校验后复制当前 `organization.json` 和 `organization.previous.json`（存在时）；`validateFiles` 校验组织 JSON 能解析且只引用目标目录中的 Markdown。恢复旧备份没有组织文件时不报错，恢复完成后的首次读取负责生成默认组织文件。未来版本只允许原样备份，当前应用恢复校验时返回明确的不兼容错误。

- [ ] **步骤 4：运行备份与存储测试**

```powershell
pnpm --filter @vykor/server exec vitest run src/application/backup/__test__/application-backup.test.ts
pnpm --filter @vykor/services exec vitest run src/notes/__test__/markdown-note-repository.test.ts src/notes/__test__/note-organization-repository.test.ts
```

预期：PASS。

- [ ] **步骤 5：提交备份支持**

```powershell
git add -- 'packages/services/src/notes/note-repository.ts' 'packages/services/src/notes/__test__/markdown-note-repository.test.ts' 'packages/server/src/application/backup'
git commit -m 'feat(backup): include note folder organization'
```

## 任务 5：贯通 Electron IPC

**文件：**
- 修改：`apps/desktop/src/shared/note-types.ts`
- 修改：`apps/desktop/src/shared/desktop-api-contract.ts`
- 修改：`apps/desktop/src/shared/ipc-channels.ts`
- 修改：`apps/desktop/src/main/features/notes/note-service.ts`
- 修改：`apps/desktop/src/main/features/notes/ipc.ts`
- 修改：`apps/desktop/src/main/features/notes/ipc.test.ts`
- 修改：`apps/desktop/src/preload/desktop-api.ts`
- 修改：`apps/desktop/src/preload/desktop-api.test.ts`

- [ ] **步骤 1：先写失败的 IPC 与 preload 测试**

断言 `note:organization:get` 和 `note:organization:save` 分别调用服务方法，保存参数不被改写；preload 使用正确频道并回传快照。

```ts
await desktopAPI.notes.saveOrganization({ organization, expectedEtag: "e1" });
expect(invoke).toHaveBeenCalledWith(
  IpcChannels.noteOrganizationSave,
  { organization, expectedEtag: "e1" },
);
```

- [ ] **步骤 2：运行测试并确认失败**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/main/features/notes/ipc.test.ts src/preload/desktop-api.test.ts
```

预期：FAIL，频道和方法不存在。

- [ ] **步骤 3：实现桌面桥接**

扩展 `DesktopNoteService`、`IpcChannels`、`IpcInvokeMap`、`DesktopAPI.notes` 和 preload：

```ts
organization(): Promise<DesktopNoteOrganizationSnapshot>;
saveOrganization(input: SaveDesktopNoteOrganizationInput): Promise<DesktopNoteOrganizationSnapshot>;
```

两项调用都通过 `withDaemonRetry`；保存失败原样抛给渲染端，由组织 hook 负责回滚和提示。

- [ ] **步骤 4：运行 IPC 测试与桌面类型检查**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/main/features/notes/ipc.test.ts src/preload/desktop-api.test.ts
pnpm --filter @vykor/desktop typecheck
```

预期：PASS。

- [ ] **步骤 5：提交 IPC**

```powershell
git add -- 'apps/desktop/src/shared' 'apps/desktop/src/main/features/notes' 'apps/desktop/src/preload'
git commit -m 'feat(desktop): bridge note organization api'
```

## 任务 6：实现渲染端组织控制器

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/desktop/notes-page/note-organization.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/notes-page/use-note-organization.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/notes-page/__test__/note-organization.test.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/notes-page/__test__/use-note-organization.test.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/notes-page/use-notes-controller.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/notes-page/__test__/use-notes-controller.test.tsx`

- [ ] **步骤 1：编写失败的控制器测试**

覆盖：组织加载后按手动顺序展示；置顶便签从 `desktop` 投影到置顶区但保持相对顺序；夹内搜索结果带文件夹名；保存时乐观更新；409 或网络错误恢复前一快照；只读快照禁止整理；正文 `updatedAt` 改变不打乱顺序。

```ts
it("rolls back an optimistic move when persistence fails", async () => {
  await render({ saveOrganization: vi.fn().mockRejectedValue(new Error("conflict")) });
  const before = latest.organization;
  await act(async () => latest.mergeNotes("a", "b"));
  expect(latest.organization).toEqual(before);
  expect(latest.error).toContain("已恢复原位置");
});
```

- [ ] **步骤 2：运行测试并确认失败**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/notes-page/__test__/note-organization.test.ts src/renderer/src/components/desktop/notes-page/__test__/use-note-organization.test.tsx src/renderer/src/components/desktop/notes-page/__test__/use-notes-controller.test.tsx
```

预期：FAIL，新模型和 hook 不存在，旧控制器仍按更新时间排序。

- [ ] **步骤 3：实现组织投影与 hook**

`useNoteOrganization(notes)` 返回：

```ts
{
  snapshot,
  desktopItems,
  pinnedItems,
  folders,
  searchResults,
  saving,
  readOnly,
  warning,
  error,
  reorder,
  mergeNotes,
  moveToFolder,
  moveToDesktop,
  renameFolder,
  dissolveFolder,
  refresh,
}
```

保存操作先保存 `before`，应用纯变换后调用 `window.desktop.notes.saveOrganization`；失败时恢复 `before`。队列中的后一操作必须基于最新已确认或乐观快照，不允许闭包捕获旧状态。页面重新聚焦时同时刷新正文和组织；有组织保存进行中时延后外部刷新，完成后再比较 etag。

修改 `useNotesController`：保留正文搜索辅助和草稿管理，但 `visibleNotes` 不再作为页面最终排序来源；已保存便签按组织控制器给出的 ID 顺序投影，未保存非空草稿临时放在桌面置顶区之后、普通项目之前，首次保存得到稳定 ID 后再写入组织文件。

- [ ] **步骤 4：运行控制器测试**

运行步骤 2 的命令。预期：PASS。

- [ ] **步骤 5：提交组织控制器**

```powershell
git add -- 'apps/desktop/src/renderer/src/components/desktop/notes-page'
git commit -m 'feat(notes): add organization controller'
```

## 任务 7：实现可测试的拖拽意图状态机

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/desktop/notes-page/note-drag-state.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/notes-page/__test__/note-drag-state.test.ts`

- [ ] **步骤 1：编写失败的阈值与取消测试**

使用 fake timers 覆盖：5.9 px 不启动、6 px 启动；同一便签连续 249/250 ms；切换目标清零；文件夹 399/400 ms；越界 23.9/24 px；滚动、Escape、系统取消清空计时器；键盘意图不等待悬停。

```ts
it("opens a folder only after continuous 400ms hover", () => {
  const machine = createNoteDragMachine();
  machine.start(pointerDrag("a"));
  machine.enter(folderTarget("f1"), 0);
  expect(machine.tick(399).intent).toEqual({ type: "hover-folder", folderId: "f1" });
  expect(machine.tick(400).intent).toEqual({ type: "open-folder", folderId: "f1" });
});
```

- [ ] **步骤 2：运行测试并确认失败**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/notes-page/__test__/note-drag-state.test.ts
```

预期：FAIL，状态机不存在。

- [ ] **步骤 3：实现纯状态机**

导出固定常量和纯事件 API：

```ts
export const NOTE_DRAG_DISTANCE = 6;
export const NOTE_MERGE_HOVER_MS = 250;
export const FOLDER_OPEN_HOVER_MS = 400;
export const FOLDER_EXIT_DISTANCE = 24;
```

状态机只判定意图，不读 DOM、不保存业务数据。DOM 边界和时间戳由 `NoteBoard` 转成事件；这样测试不依赖 jsdom 布局。

- [ ] **步骤 4：运行状态机测试**

运行步骤 2 的命令。预期：PASS。

- [ ] **步骤 5：提交状态机**

```powershell
git add -- 'apps/desktop/src/renderer/src/components/desktop/notes-page/note-drag-state.ts' 'apps/desktop/src/renderer/src/components/desktop/notes-page/__test__/note-drag-state.test.ts'
git commit -m 'feat(notes): model folder drag intentions'
```

## 任务 8：接入 dnd-kit 并实现统一桌面

**文件：**
- 修改：`apps/desktop/package.json`
- 修改：`pnpm-lock.yaml`
- 创建：`apps/desktop/src/renderer/src/components/desktop/notes-page/note-board.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/notes-page/note-folder.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/notes-page/__test__/note-board.test.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/notes-page/note-list.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/notes-page/notes-page.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/notes-page/__test__/notes-page.test.tsx`

- [ ] **步骤 1：声明 dnd-kit 直接依赖**

```powershell
pnpm --filter @vykor/desktop add -D '@dnd-kit/core@6.3.1' '@dnd-kit/sortable@10.0.0' '@dnd-kit/utilities@3.2.2'
```

预期：`apps/desktop/package.json` 出现直接依赖，锁文件不依赖 `@lobehub/ui` 的传递声明。

- [ ] **步骤 2：编写失败的页面和拖拽组件测试**

测试：没有“桌面／收纳”切换；顶层同时出现便签和文件夹；拖拽浮层只有一份；合并预览只有达到 250 ms 后出现；文件夹达到 400 ms 后展开；拖出越界后先关闭再提交桌面落点；Escape 不调用保存；保存失败恢复 DOM 顺序；键盘拿起、移动、放下和播报；减少动态效果仍保留阈值。

测试不依赖真实像素布局：为 `NoteBoard` 注入 `getRect(id)` 和时钟，或用 dnd-kit 的事件适配层直接驱动状态机，断言组织控制器调用顺序。

- [ ] **步骤 3：运行页面测试并确认失败**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/notes-page/__test__/note-board.test.tsx src/renderer/src/components/desktop/notes-page/__test__/notes-page.test.tsx
```

预期：FAIL，旧页面仍显示双模式和总收纳夹。

- [ ] **步骤 4：实现 `NoteBoard` 和可复用便签纸片**

使用 `DndContext`、`PointerSensor`、`TouchSensor`、`KeyboardSensor`、`SortableContext`、`rectSortingStrategy` 和 `DragOverlay`。Pointer/Touch 使用 6 px activation constraint；键盘使用 sortable keyboard coordinates。碰撞策略先找打开文件夹内部容器，再找文件夹封面和便签合并目标，最后找桌面排序落点。

从 `NoteList` 抽出 `NotePaperCard`，dnd-kit 的 transform 只施加在 sortable 外层；卡片本体继续使用 Motion 的 `layoutId` 做打开详情转场。拖拽浮层渲染静态纸片，不绑定 `layoutId`，避免 Motion 与 dnd-kit 竞争 transform。

- [ ] **步骤 5：实现 `NoteFolder` 原位开合**

复用现有 `ProjectFolder` 的视觉和 Portal/焦点能力，但把“最多五张预览 + expandedContent”改成由单个业务文件夹驱动。悬停开夹不转移焦点；点击开夹遵循正常焦点陷阱；拖出自动关夹后焦点保持在拖拽会话，不抢回封面。更多菜单提供重命名和解散。

- [ ] **步骤 6：改造 `NotesPage` 为统一桌面**

删除 `mode`、`changeMode`、总 `ProjectFolder`、收纳按钮和相关图标。顶部保留标题、搜索和“记一句”。错误区域合并正文保存错误与组织保存错误。搜索模式使用 `searchResults`：桌面便签可直接打开；夹内便签显示“位于：文件夹名”；匹配文件夹名时显示文件夹并可打开。

- [ ] **步骤 7：运行页面测试和桌面类型检查**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/notes-page/__test__/note-board.test.tsx src/renderer/src/components/desktop/notes-page/__test__/notes-page.test.tsx src/renderer/src/components/desktop/notes-page/__test__/note-editor-motion.test.tsx
pnpm --filter @vykor/desktop typecheck:web
```

预期：PASS。

- [ ] **步骤 8：提交统一桌面**

```powershell
git add -- 'apps/desktop/package.json' 'pnpm-lock.yaml' 'apps/desktop/src/renderer/src/components/desktop/notes-page'
git commit -m 'feat(notes): replace collection mode with folders'
```

## 任务 9：补齐搜索、置顶、重命名、解散和可访问性

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/desktop/notes-page/note-organization.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/notes-page/use-note-organization.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/notes-page/note-board.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/notes-page/note-folder.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/notes-page/note-actions.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/notes-page/__test__/note-organization.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/notes-page/__test__/note-board.test.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/notes-page/__test__/notes-page.test.tsx`

- [ ] **步骤 1：增加失败的完整行为测试**

覆盖：夹内正文搜索带归属；文件夹名搜索；置顶/取消置顶同步保存组织顺序；重命名空白、超长和冲突名称的明确处理；解散按原索引连续插入；只读未来版本禁用拖拽、重命名和解散；aria-live 播报创建、放入、移出、解散、取消和失败；编辑器打开的便签不可拖动。

- [ ] **步骤 2：运行测试并确认失败**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/notes-page/__test__/note-organization.test.ts src/renderer/src/components/desktop/notes-page/__test__/note-board.test.tsx src/renderer/src/components/desktop/notes-page/__test__/notes-page.test.tsx
```

预期：FAIL，至少缺少完整播报、只读禁用或置顶持久顺序。

- [ ] **步骤 3：完成剩余规则**

文件夹名称 `trim` 后必须为 1–80 个 Unicode 字符；允许同名，因为 ID 才是身份。重命名使用现有轻量浮层或就地输入，不增加大弹窗。置顶变化先更新本地 appearance，再以当前 `desktop` 相对顺序保存组织快照；保存失败时同时回滚 appearance 和组织快照，避免两者分裂。

使用 dnd-kit `screenReaderInstructions` 和 announcements，中文播报具体文件夹名及位置。减少动态效果只把 Motion transition 设为 0，不改变状态机时间/距离常量。

- [ ] **步骤 4：运行完整便签页定向测试**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/notes-page/__test__
```

预期：PASS。

- [ ] **步骤 5：提交完整行为**

```powershell
git add -- 'apps/desktop/src/renderer/src/components/desktop/notes-page'
git commit -m 'feat(notes): complete folder organization behavior'
```

## 任务 10：更新文档并执行最终验证

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/desktop/notes-page/README.md`
- 修改：`packages/services/src/notes/README.md`
- 修改：`docs/superpowers/specs/2026-10-27-note-folders-design.md`（仅补实现状态和实际偏差）

- [ ] **步骤 1：更新分类 README**

桌面 README 写清入口 `NotesPage -> NoteBoard -> useNoteOrganization -> window.desktop.notes`、拖拽状态归属、搜索与置顶投影和新增代码放置建议。服务 README 写清 Markdown 与 `organization.json` 的职责边界、原子写入、条件保存、备份和损坏恢复。

- [ ] **步骤 2：运行格式与定向测试**

```powershell
pnpm exec prettier --check 'packages/services/src/notes/**/*.{ts,md}' 'packages/domain-contracts/src/notes/**/*.ts' 'packages/protocol/src/knowledge/notes.ts' 'packages/server/src/application/notes/**/*.ts' 'packages/server/src/http/routes/notes.ts' 'packages/client/src/resources/workspace/note-resource.ts' 'apps/desktop/src/{main,preload,shared,renderer}/**/*note*.{ts,tsx}' 'docs/superpowers/specs/2026-10-27-note-folders-design.md'
pnpm --filter @vykor/services exec vitest run src/notes/__test__
pnpm --filter @vykor/server exec vitest run src/application/notes/__test__/note-application-service.test.ts src/http/routes/__test__/notes.test.ts src/application/backup/__test__/application-backup.test.ts
pnpm --filter @vykor/desktop exec vitest run src/main/features/notes/ipc.test.ts src/preload/desktop-api.test.ts src/renderer/src/components/desktop/notes-page/__test__
```

预期：全部 PASS。

- [ ] **步骤 3：运行类型、文档和退役 UI 检查**

```powershell
pnpm --filter @vykor/desktop typecheck
pnpm check-types:server-client
pnpm check:retired-ui
pnpm check-docs
```

预期：全部退出码 0。若 `check-types:server-client` 再次出现无输出挂起，记录进程与超时证据，不把它报告为通过；其他检查继续执行。

- [ ] **步骤 4：人工交互验收**

在桌面应用中逐项验证：

1. 点击便签不会误拖，拖动达到 6 px 才拿起。
2. A 在 B 上停留 250 ms 后松手，文件夹出现在 B 原位置并自动取 B 标题。
3. 便签在文件夹上停留 400 ms 后原位展开，拖拽纸片不跳动。
4. 夹内便签越界 24 px 后文件夹先关闭，再在桌面落位。
5. 取出后只剩一张时自动解散；删除文件夹按夹内顺序展开且不删除正文。
6. 重启后文件夹、归属和顺序保持；编辑正文不改变网格顺序。
7. 搜索能找到夹内便签和文件夹名并显示归属。
8. 鼠标、触控板和键盘均可排序，Escape 恢复原位置。
9. 开启减少动态效果后没有位移补间，但阈值与结果不变。
10. 外部修改 `organization.json` 后保存产生冲突提示，不静默覆盖；未来版本进入只读。

- [ ] **步骤 5：同步规格实现状态并提交**

只记录已验证事实，不修改已确认产品规则：

```powershell
git add -- 'apps/desktop/src/renderer/src/components/desktop/notes-page/README.md' 'packages/services/src/notes/README.md' 'docs/superpowers/specs/2026-10-27-note-folders-design.md'
git commit -m 'docs: record note folder implementation and verification'
```

- [ ] **步骤 6：最终检查提交范围**

```powershell
git status --short
git log --oneline -10
```

预期：工作区没有本功能遗留改动；提交按模型、存储、API、备份、IPC、控制器、拖拽、界面和文档分开。

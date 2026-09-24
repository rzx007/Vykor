# 项目外绝对路径文件预览设计

## 背景

Agent 写个人 skill、`USER.md` 等文件时，工具入参里的路径经常是盘上的绝对路径，例如：

- Windows：`C:\Users\ruanz\.vykor\skills\show-me\SKILL.md`
- Unix：`/Users/ruanz/.vykor/skills/show-me/SKILL.md`

对话里的「已编辑文件」卡片会原样列出这条路径。点开后有两道门都会丢掉它：

1. `utility-panel.tsx` 的 `toRelativeWorkspacePath`：对不上当前项目盘符就只打开空 Files 页；`/Users/...` 没有盘符，会被剥成项目里的假相对路径。
2. `files-tool.tsx` 的 `toProjectRelativePath` 和主进程 `resolveInsideRoot`：项目外绝对路径返回 `null` 或直接拒绝。

## 目标

- 点「已编辑文件」、回复里的文件链接，或其它走 `onOpenFile` 的入口时，只要路径落在允许范围内，右侧 Files 就能预览。
- Windows `C:\...`、`\\?\C:\...` 和 Unix `/Users/...`、`/home/...` 走同一套主进程判断：先解析成本机路径，再看落在哪个允许根里。主进程不写 `/Users`、`/home` 这类前缀名单，不引入第三方路径库。
- 项目内文件行为不变：相对路径（含 `/src/foo.ts`）、项目内绝对路径仍打开预览；有 git 时卡片仍进 Review。
- 项目外、但在允许范围内的文件：只预览，不进 Review，不进文件树，不持久化标签页。

## 非目标

- 不开放整盘任意路径，也不把整个 `~/.vykor` 当成可读树（`credentials.json`、`settings.json` 不在本次预览范围）。
- 不把个人配置或文档目录挂进右侧文件树。
- 不给项目外文件做 git diff / Review。
- 不恢复上次会话里打开过的项目外标签页。
- 不改 Agent 沙箱、写文件权限或 skill 安装流程。
- 不新增 `pathe`、`is-path-inside` 等依赖。
- 不把 `@vykor/core` 加进桌面 production 依赖（打包约束，见 `apps/desktop/docs/packaging.md`）。

## 允许范围

主进程在读文件时组装允许范围，不交给渲染进程做安全判断。允许根**始终按路径字符串参与匹配**，不先 `stat` / `exists`。根或文件不存在时走现有「无法预览」，不影响项目内打开。

| 范围 | 怎么得到 | 放行条件 | 面包屑左侧 |
|---|---|---|---|
| 当前项目 | IPC 传入的 `rootPath`（当前选中项目，或项目外会话自己的工作目录） | 落在该目录内 | 现有项目名 |
| 个人 skill | `join(configDir, "skills")`。`configDir` = `VYKOR_CONFIG_DIR`，否则 `join(homedir(), ".vykor")` | 落在 `skills` 目录内 | 个人配置 |
| 用户档案 | `join(configDir, "USER.md")` | 规范化后等于该文件 | 个人配置 |
| 项目外工作区 | 已有的 `buildOutsideProjectRoot(documentsPath)`，即文档目录下的 `Vykor` | 落在该目录内 | 项目外工作区 |

`configDir`、`documentsPath` 由主进程启动时注入 `WorkspaceService`，分类函数不调用 `app.getPath`、`homedir` 或 `process.cwd()`。

### 多个根同时命中时

**先当前项目，再额外范围。重叠时 `kind` 必须是 `project`。**

项目外会话的 cwd 已是 `Documents/Vykor/<日期>/xN`：该目录内的文件按项目文件处理（进树、可持久化、面包屑用项目名）。隔壁 `x2` 下的文件才是 `extra-root`。

当前项目恰好是 `~/.vykor` 时同样：项目内文件仍是 `project`，面包屑用项目名，不用「个人配置」。

个人配置只放行 `skills/` 与 `USER.md`。项目仓库里的 `.vykor` 若位于当前项目下，按当前项目处理，不用特判。

## 路径分类（两轮）

入口：`classifyWorkspacePath(rawPath, roots, pathOps)`。  
`roots` 至少包含 `projectRoot`、`skillsDir`、`userProfilePath`、`outsideProjectRoot`。  
`pathOps` 注入 `win32` / `posix` 以及「把某条根转成可比较绝对路径」的方法，与 `outside-project-workspace.ts` 相同，方便在任意 CI 操作系统上测 Windows / POSIX。  
状态：只读字符串，不碰磁盘。  
结果：`{ kind: "project" | "extra-root", rootPath, relativePath, tabPath, rootLabel }`，或不接受。

`relativePath` 相对**展示根**：个人 skill 相对 `configDir`，所以面包屑是 `个人配置 / skills / show-me / SKILL.md`；`USER.md` 是 `个人配置 / USER.md`；项目外工作区相对 `Vykor` 根。
`tabPath` 是标签页身份：项目文件仍用相对路径；项目外文件用规范化后的绝对路径（统一 `/`），避免和项目里同名相对路径撞车。

### 预处理

去掉首尾空白和 `:行号` / `:行号:列号` 后缀。这一步与现在渲染进程的剥行号一致。

### 第一轮：当成绝对路径

用 Node 自带的 `path.win32` 和 `path.posix` 收集候选，不自己写前缀名单：

1. `win32.isAbsolute(raw)` 为真 → 收一条规范化后的 Windows 绝对路径（去掉 `\\?\` 再 `win32.resolve` 该路径自身，**不要**对 POSIX 路径做一次无根的 `win32.resolve`）。
2. 把 `\` 换成 `/` 后 `posix.isAbsolute` 为真 → 收一条 POSIX 规范化结果。
3. Windows 上要把 POSIX 绝对路径映射到本机时：**对每个允许根，用该根自己的盘符**做 `win32.resolve(rootDrive, posixPath)`。例如项目在 `E:\code\...`、个人配置在 `C:\Users\ruanz\.vykor` 时，`/Users/ruanz/.vykor/skills/x.md` 只会对着 `C:\` 映射成 `C:\Users\ruanz\.vykor\skills\x.md`，不会变成 `E:\Users\...`。

对每个候选，判断是否落在某个允许范围内：`relative(root, candidate)` 为空，或不以 `..` 开头、也不是另一条绝对路径。比较前：Windows 上 `resolve`、去掉 `\\?\`、按该平台规则处理大小写。短路径（`8.3`）若分类阶段无法展开，留给读文件前的 `realpath`。

匹配顺序见上：**项目优先**。

### 第二轮：当成项目相对路径

第一轮没有命中任何允许范围时，保持现在的行为：去掉开头的 `./` 和 `/`，再走现有的 `resolveInsideRoot(projectRoot, relative)`。

因此 `/src/foo.ts` 在 Windows 上即使被当成 `E:\src\foo.ts`，也不在允许范围内，然后退回项目内的 `src/foo.ts`。

`/etc/passwd` 第一轮不在允许范围，第二轮变成项目里的 `etc/passwd`。这与现有 `resolveInsideRoot` 一致：若项目里真有这个文件就打开它，这是相对路径回退，不是 extra-root 读系统文件。

跨操作系统的另一边路径（在 Mac 上收到 `C:\Users\...`）对不上允许根，再按相对路径处理；对不上项目就拒绝。不发明盘符到 Unix 的映射。

## 主进程读文件

`WorkspaceService.readFile` 不再一律 `resolveInsideRoot`。

1. `classifyWorkspacePath(input.path, roots, pathOps)`。
2. 用分类得到的真实路径做 `realpath`（或 Windows 等价规范化）。再套一次允许范围判断；逃出则拒绝（允许根内的 symlink / junction 指向根外时，不能读到目标内容）。
3. 继续现有的 `stat`、大小上限、二进制检测、内容解码。
4. 返回值在现有字段上增加：

```ts
scope: "project" | "extra-root"
relativePath: string
rootLabel: string
```

`path` 字段改存 `tabPath`。`name`、`language`、`size`、`binary`、`content` 不变。`FileViewerTab.preview` 直接带上这些新字段。

`revealPath`、`copyPath`、`openWith` 必须走同一套分类；`rootPath` 缺失时拒绝，不再 `resolve(path)` 裸开。文件树右键继续传项目相对路径。预览里「在文件夹中显示」传 `tabPath`。`listFiles` 不改。

`opener-service.ts` 里那份独立的 `resolveInsideRoot` 删掉或改成调用 `workspace-path.ts`，避免以后只改一处。

分类与规范化放在 `apps/desktop/src/main/features/workspace/workspace-path.ts`。

## 渲染进程

渲染进程不负责「能不能读」。它只决定点哪里、标签页怎么显示。

主进程不写盘符名单；渲染进程分流**只用** Windows 盘符 / UNC / `\\?\`，**不用**开头 `/`。`/src/foo.ts` 继续当项目相对路径。

### 第一道门：`utility-panel.tsx`

`fileOpenRequest` 不再用 `toRelativeWorkspacePath` 当标签身份。

- 先打开 Files 工具页，把**原始路径**交给后续 `readFile`。
- `startFileTab` / `fileTabId` / `setActiveFilePath` / `upsertFileTab` 只在 `readFile` 成功后用返回的 `path` 写入。读成功前不要用剥过的相对路径占位，否则会和 `tabPath` 裂成两个标签。
- loading 可以用原始路径做转圈，但不写入持久化缓存。

### Files 面板

`files-tool.tsx` 的 `openRequest` 不再先 `toProjectRelativePath` 再可能丢掉。调用 `workspace.readFile({ rootPath: 当前项目, path: 原始路径 })`。

打开成功后：

- `activePath` / 标签页身份用返回的 `path`。
- `FileBreadcrumb` 改吃当前标签的 `preview`：`scope === "project"` 时仍是「项目名 / a / b / 文件」；`extra-root` 时左侧用 `rootLabel`，后面用 `relativePath`。
- 文件树不选中任何行。
- 跳到行号：用返回的 `path`（或仍有效的 `openRequest.id`）对齐，不要拿原始绝对路径和 `activePath` 做 `===`。
- `file-viewer.tsx` 的「用浏览器打开」只对 `scope === "project"` 提供。extra-root 的 `path` 已是绝对路径，不能再拼到项目根上。
- `persistFileTabs` 只保存 `preview.scope === "project"` 的标签；`activePath` 若是 extra-root，不要写进缓存。没有 `scope` 的旧标签当 `project`。恢复时继续只保留文件树里存在的路径（现有 `restoreOpenFiles` 已这样做）。

文件树点击仍传项目相对路径。

### 对话「已编辑文件」

卡片仍列出工具给出的原始路径。

点击一行时只做路由：

- 能转成当前项目相对路径（含 `/src/foo.ts`、项目内绝对路径）且 `canOpenReview` → `onOpenReview`。
- 否则 → `onOpenFile`。

「能转成当前项目相对路径」放在 `apps/desktop/src/shared` 的纯函数里，不引用 `node:path`：Windows 盘符 / UNC / `\\?\` 且前缀是当前项目 → 相对路径；其它以 `/` 或 `./` 开头的当作项目相对路径（剥掉前缀）。只有盘符 / UNC 且**不是**当前项目前缀，才直接走预览。

项目外文件对不上 git 变更，卡片上继续没有 `+/-` 行数。

`assistant-message.tsx`、`files-tool.tsx`、`review-tool.tsx`、`utility-panel.tsx` 里四份路径转换，打开 / Review / 面板分流改用上述 shared 函数；返回值约定：对不上项目的 Windows 绝对路径返回 `null`（走预览），`/src/foo.ts` 返回 `src/foo.ts`。

### Review

Review 只处理能转成当前项目相对路径的文件。盘符 / UNC 落在项目外时，不设置 `activePath`，也不为它拉 diff。`/src/foo.ts` 仍剥成 `src/foo.ts` 后进 Review。

## 数据流

1. 用户点「已编辑文件」里的 `C:\Users\...\skills\show-me\SKILL.md`（或回复里的文件链接）。
2. `utility-panel.tsx` 打开 Files，不把这条路径收成项目相对路径。
3. Files 把原始路径和当前项目路径发给主进程 `workspace.readFile`。
4. 主进程两轮分类：用个人配置根自己的盘符映射后，落在 `skills/` → `extra-root`。
5. `realpath` 仍在允许范围内，读文件，返回内容、`tabPath`、`relativePath`、`rootLabel`。
6. 面板用返回的 `path` 建标签。面包屑显示「个人配置 / skills / show-me / SKILL.md」。文件树不动。

项目内 `src/foo.ts`、`/src/foo.ts` 或 `E:\code\vykor\src\foo.ts` 仍走原来的预览 / Review。

## 错误处理

| 情况 | 表现 |
|---|---|
| 落在允许范围，但文件不存在或不是文件 | 现有「无法预览」错误，不静默 |
| 两轮都不接受 | 现有「文件必须位于当前项目目录内。」 |
| `realpath` 后逃出允许范围 | 同上，拒绝读取 |
| 超过现有大小上限 | 现有超大文件结果（不读内容） |
| 当前没有选中项目 / 工作区 | Files 保持现有空状态，不发起读取 |
| `rootPath` 缺失的 reveal / copy / openWith | 拒绝，不裸开路径 |
| 配置目录尚未创建 | 仍按字符串匹配；文件不存在则「无法预览」 |

不把项目外绝对路径吞掉后假装没点过。

## 测试

按 TDD，先写分类函数和 `readFile` 测试（必须在当前实现上失败），再改主进程和渲染进程。分类测试注入路径 API 和三个根，不依赖 CI 操作系统，也不读 `process.cwd()`。

分类函数：

1. 项目内相对路径 `src/a.ts` → `project` + `src/a.ts`。
2. 项目内 Windows 绝对路径 → `project` + 相对路径。
3. `skills` 下的 Windows 绝对路径、`\\?\` 前缀 → `extra-root`；`USER.md` 精确匹配 → `extra-root`；`credentials.json` / `settings.json` → 不能变成 `extra-root`。
4. `/Users/.../skills/...`、`/home/.../skills/...`：用**该根自己的盘符**映射后命中；项目在 `E:`、配置在 `C:` 时也要命中，不能变成 `E:\Users\...`。
5. `/src/foo.ts` → 不当成盘根下的绝对文件，回退为项目相对 `src/foo.ts`。
6. `/etc/passwd`、其它盘上的任意文件 → 不能变成 `extra-root`；若项目里存在 `etc/passwd`，第二轮可以打开那个项目文件。
7. `Documents/Vykor/...` 下、且不是当前项目内的文件 → `extra-root`。
8. 当前项目是 `Documents/Vykor/2026-09-06/x1` 时：该目录内 → `project`；隔壁 `x2` → `extra-root`。当前项目是 `~/.vykor` 时：项目内 → `project`。
9. 配置根尚未创建：仍按字符串匹配，不因 `exists === false` 跳过。
10. `VYKOR_CONFIG_DIR` 指到别的盘时，POSIX 路径按那个根的盘符映射。

`WorkspaceService.readFile`：

1. 允许范围内的真实临时文件能读到内容，且 `scope` / `path` / `relativePath` 正确。
2. 允许范围外的绝对路径不能读到盘上的原文件。
3. 允许根内的 symlink / junction 指向根外 → 不能读到目标内容。
4. 项目相对路径、大小上限、二进制检测保持原样。
5. `openWith` / `revealPath` 在 `rootPath` 缺失时拒绝。

渲染进程（分流函数单独测，不和「开头 `/`」绑在一起）：

1. `utility-panel` 收到项目外绝对路径时把原始路径交给 `readFile`，不用 `toRelativeWorkspacePath` 占位标签。
2. `/Users/...` 不会被剥成项目相对路径。
3. `/src/foo.ts` 且有 git → `onOpenReview`，路径为 `src/foo.ts`。
4. 项目外 Windows 绝对路径 → `onOpenFile`，不调用 `onOpenReview`。
5. Review 忽略项目外盘符 / UNC 的 `openRequest`，但接受 `/src/foo.ts`。
6. 跳到行号在 `tabPath` 与原始路径不同时仍有效。

实现后跑桌面相关测试、Node / Web 类型检查，以及对改动文件的 lint。

## 改动文件

- 新：`apps/desktop/src/main/features/workspace/workspace-path.ts` 及测试
- 新：`apps/desktop/src/shared` 下的分流 / 项目相对路径纯函数及测试
- `workspace-service.ts`、`opener-service.ts`、`workspace-types.ts`
- `utility-panel.tsx`、`files-tool.tsx`、`file-viewer.tsx`、`browser-navigation.ts`（若 HTML 拼 URL 仍假设相对路径）
- `assistant-message.tsx`、`review-tool.tsx`

## 取舍

分类放在主进程，渲染进程只做点击分流：安全边界只有一处。`readFile` 的 `path` 从「一定是项目相对路径」变成「分类后的标签身份」，靠 `scope` 区分。标签身份只在读取成功后写入，避免面板先造一个错误标签。

个人配置不开放整树：本次要预览的是 skill 和 `USER.md`。把 `credentials.json` 留在范围外，避免会话里的路径把凭据读进预览。

POSIX 路径在 Windows 上按**每个允许根的盘符**映射，不按进程 cwd 的盘符。这样项目在 E:、家目录在 C: 时主用例仍然成立。

不持久化项目外标签：个人 skill 路径随用户和机器变化，写进按项目分的标签缓存会留下打不开的条目。

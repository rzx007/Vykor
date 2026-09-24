# 默认文件打开目标设计

## 背景

设置页「常规 → 默认文件打开目标」现在是写死的「VS Code」按钮，点了不会保存，也不会改对话右上角的打开方式。

右上角打开按钮和文件树里的「打开方式」已经能扫描本机应用并打开项目或文件。右上角选过一次后，会把 id 写进 `localStorage`（`vykor.desktop.open-with.v1`）。设置页和右上角没有共用默认值。

设置页是 `/settings` 路由，对话页是 `/_main` 路由，同一窗口里不同页面，不会同时挂着。主窗口之外的宠物窗口不读这项设置。

## 目标

- 只在设置页改默认打开方式。回到对话后，右上角默认显示并使用这个应用。
- 右上角和文件树点某个应用只负责打开，不再记住、也不回写默认值。
- 设置页下拉和右上角用同一份本机应用列表、同一套图标（`OpenerIcon`，优先系统读到的应用图标）。
- Windows / macOS / Linux 都走现有 `listOpeners()` 检测，不按系统写死候选项或图标。

## 非目标

- 不改「运行环境」。
- 不改「集成终端 Shell」；侧边栏里按项目手填默认 Shell 保持原样。
- 不把打开方式同步到对话服务、其它设备或多窗口。
- 不新增打开应用检测，不改各端启动参数。
- 不把以前 `localStorage` 里「上次选过谁」迁到新默认值。
- 不靠窗口内事件让右上角「立刻」换图标（设置页保存时对话页不在树上）。

## 数据存哪

默认值是本机桌面偏好，和「通知」同一份文件：

- 文件：`userData/desktop-preferences.json`
- 字段：`defaultOpenerId`，字符串或省略。文件里没有该字段时不要写成 `null`
- 合法值：去掉首尾空白后仍非空的字符串。缺字段、非法值、只含空白、文件损坏都当成「没有默认」

`DesktopPreferences` 必须同时读回 `notificationMode` 和 `defaultOpenerId`。任何一次 `patchDesktopPreferences` 都不能丢掉另一个字段。改通知不得抹掉打开方式，改打开方式也不得抹掉通知。

`DesktopSettingsSnapshot` 增加 `defaultOpenerId: string | null`（没有默认时为 `null`）。  
`buildDesktopSettingsSnapshot` 的本机偏好参数要能接收 `defaultOpenerId`。工作风格仍来自 daemon（桌面后面的本地服务）。

新增 IPC：`settings:update-default-opener`。  
入参类型 `UpdateDesktopDefaultOpenerInput`：`{ defaultOpenerId: string }`。  
主进程先 `trim`，空串拒绝（清空不是这次的需求）。写入的是 trim 后的字符串，不做「是不是已安装应用」校验：打开时仍由 `opener-service` 按 id 查表，找不到就报「未找到该打开方式」，不会按用户传入的 id 去起进程。

**写成功的标准是本机文件写成功。** `patchDesktopPreferences` 写盘失败必须让这次 IPC 抛错，不能只 `console.warn` 还返回新对象。daemon 只用来拼 snapshot 里的工作风格；它挂了不能把已经写成功的本机默认说成失败。此时仍返回 snapshot：`defaultOpenerId` / `notificationMode` 用本机值，`workStyle` 回落 `practical`。

渲染进程通过 `window.desktop.settings.updateDefaultOpener` 保存。

## 谁读、谁写

| 入口 | 读默认 | 写默认 |
|---|---|---|
| 设置页「默认文件打开目标」 | 是 | 是 |
| 对话右上角 `OpenWithSplitButton` | 是 | 否 |
| 文件树 `OpenWithSubmenu` | 是，当前默认项用和右上角一样的高亮 | 否 |

`launchWorkspaceOpener` 去掉 `persist`。右上角和文件树调用时只打开。

不再读、不再写 `localStorage` 键 `vykor.desktop.open-with.v1`。已经存在的旧值忽略。用户需要在设置页重新选一次默认应用。不再使用旧事件名 `vykor:open-with-changed`。

### 对话页怎么拿到新默认

设置页保存 → 本机文件写成功 → 用户回到 `/_main` → `useWorkspaceOpeners` 重新挂载，再读本机偏好。

不把窗口内 `CustomEvent` 当主路径。也不要求多窗口一起变。

对话页和设置页读 `defaultOpenerId` **不能绑死** 现在的 `settings.snapshot()`（它会先问 daemon 要工作风格）。daemon 挂了时：本机已存的默认仍要能读到，右上角仍能打开。实现上让 `snapshot()` 先读本机偏好，daemon 只补工作风格；daemon 失败时本机字段照常返回。`useWorkspaceOpeners` 只依赖这份本机字段和 `listOpeners()`，不因 daemon 失败改走「没有默认」或整颗按钮报错。

## 列表从哪来

设置页候选项 = `workspace.listOpeners()`，和右上角同一份结果。当前机器没检测到的应用不出现。

三端检测保持 `opener-service.ts` 现有逻辑：

- Windows：VS Code、Visual Studio、Cursor、Antigravity、GitHub Desktop、文件资源管理器；有 Windows Terminal 显示「终端」，否则 PowerShell；装了 Git 才有 Git Bash；有 `wsl.exe` 才有 WSL。
- macOS：VS Code、Cursor、Xcode、Antigravity、GitHub Desktop、Finder；终端优先 iTerm，否则系统终端。
- Linux：VS Code / code-oss、Cursor、Antigravity、GitHub Desktop、文件管理器；终端按已装的 gnome-terminal / Konsole / xfce4-terminal / kitty / `x-terminal-emulator` / `xterm` 选一个。

同一类应用三端共用 id（`vscode`、`cursor`、`terminal`）。文件夹入口 id 本来就不同（`explorer` / `finder` / `files`）。保存的是当前系统那个 id；换系统后对不上就走回退，不会误开别的程序。

## 默认怎么解析

抽出并导出现在的 `resolveSelectedOpener`（可留在 `use-workspace-openers.ts`，或放到同目录小模块）。设置页和 hook 都 import 这一条，禁止再抄一份 if/else。

输入是「当前列表 + 本机 `defaultOpenerId`」：

1. 列表为空 → `null`（没有可用打开方式）
2. `defaultOpenerId` 能在列表里找到 → 用这一项
3. 否则按顺序找：`cursor` → `vscode` → 列表第一项

解析结果同时用于：

- 设置页触发按钮上的图标和名称
- 设置页 Select 的 `value` 和高亮（用解析后的 id，不用 snapshot 里可能已失效的原始 id，避免卸掉应用后下拉空白）
- 右上角按钮当前应用和菜单高亮
- 文件树「打开方式」子菜单高亮

本机偏好还没读回来时，不要先按回退画一个图标再跳到真实默认。等偏好读完再定选中项；列表可以先出来。

## 设置页 UI

把写死的 `SettingSelect`（通用 `Code2` 图标 + 「VS Code」）换成真正的下拉，交互对齐「工作风格 / 通知」：

- 打开页时读 snapshot（本机字段不依赖 daemon）+ `listOpeners()`
- 选一项就保存
- 加载中或保存中禁用
- 失败则回到改之前的选项，控件右侧用同一套红色说明

每一项和触发按钮都复用 `OpenerIcon`：有 `iconDataUrl` 用系统图标，没有则按 `kind` 用现有兜底（编辑器 / 文件夹 / 终端）。不要再用设置页那枚通用代码括号图标。

当前默认项在下拉里高亮。列表为空时下拉禁用，文案「未找到可用的打开方式」，不假装还能选 VS Code。

## 失败和空状态

- 保存偏好失败（写盘抛错）：设置页回滚并提示。对话页当时不在树上；下次进入仍读盘上的旧值。
- 读偏好失败或值非法：当成没有默认，走回退，设置页不因此空白或报错。
- daemon 挂了：仍能读、写本机默认，仍能打开应用。
- 打开应用失败：仍由系统处理，不改默认值。
- `listOpeners()` 失败或为空：设置页禁用下拉；右上角保持现有不可用状态，不额外弹错。

## 测试

先写测试再改实现。

1. **本机偏好**（`desktop-preferences.test.ts`）：能读写合法 `defaultOpenerId`；非法值、只含空白、坏文件都回落到「没有默认」。改打开方式不影响 `notificationMode`；改通知不影响已保存的 `defaultOpenerId`。写盘失败要抛错，不能当成成功。
2. **默认解析**（抽出后的 `resolveSelectedOpener`）：保存的 id 在列表里就用它；不在列表或为空时按 Cursor → VS Code → 第一项。设置页和 hook 都引用这一条导出函数。
3. **写入方向**（新建 `use-workspace-openers.test.ts`）：设置页保存会更新默认；右上角 / 文件树打开不调用 `updateDefaultOpener`、不写 localStorage。
4. **UI：** 设置页选项来自 `listOpeners()`，触发按钮用 `OpenerIcon`，Select 的 `value` 是解析后的 id，不写死 VS Code。文件树子菜单高亮当前默认。
5. **snapshot 形状：** 更新这些会立刻红的精确比对 / 字面量：
   - `apps/desktop/src/main/features/settings/settings-service.test.ts`（`toEqual` 只有 `workStyle` + `notificationMode`）
   - `apps/desktop/src/renderer/src/stores/desktop-session/notification-observer.test.ts`
   - `apps/desktop/src/main/features/settings/desktop-preferences.test.ts`
   
   旧偏好没有 `defaultOpenerId` 时，snapshot 该字段为 `null`。

验证时跑桌面相关测试、改动文件的 lint 和类型检查。

## 关键改动位置

- `apps/desktop/src/shared/settings-types.ts` — snapshot 增加字段；`UpdateDesktopDefaultOpenerInput`；`buildDesktopSettingsSnapshot` 本机参数带上 `defaultOpenerId`
- `apps/desktop/src/main/features/settings/desktop-preferences.ts` — 两字段一起读回；写失败抛错
- `apps/desktop/src/main/features/settings/settings-service.ts` 与 IPC / preload / 合约 / `ipc-channels.ts` — 新增更新接口；snapshot 本机字段不依赖 daemon
- `apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx` — 真实下拉，value 用解析后的 id
- `apps/desktop/src/renderer/src/components/desktop/open-with/use-workspace-openers.ts` — 导出解析函数；改读本机偏好；去掉 persist / localStorage
- `apps/desktop/src/renderer/src/components/desktop/open-with/open-with-split-button.tsx` — 打开时不再 persist
- `apps/desktop/src/renderer/src/components/desktop/open-with/open-with-submenu.tsx` — 用 `selected` 高亮当前默认

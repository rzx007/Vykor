# 交付记录：原生磨玻璃窗口（Windows Acrylic / macOS Vibrancy）

- 计划：`docs/superpowers/plans/2026-09-22-desktop-native-window-material.md`（第 2 版）
- 分支：`feat/desktop-window-material`（工作区 `.worktrees/desktop-window-material`，起点 `d2285157`）
- 执行方式：subagent-driven-development（每个任务一个实现子代理 + 独立任务审查；结尾整分支审查 + 一轮修复波 + 定向复审）

## 1. 变更清单（13 个提交，31 个文件）

| 提交 | 内容 |
| --- | --- |
| `eefe08eb` | 共享材质类型与 argv 编解码（`shared/window-material-types.ts`） |
| `a1da5bb0` | 主进程材质选项纯函数（`window-material.ts`，12 用例） |
| `dc8a3464` | 修复轮：`applyMainWindowMaterial` 补 5 个聚焦测试、非 linux 平台显式兜底、fixture 校正 |
| `4fa0c76e` | Windows 有界双帧重绘补偿（`window-material-repaint.ts`） |
| `a6d26b73` | 偏好存储（`window-material-preference.ts`）+ `window.ts` 建窗接线 |
| `e6741e1c` | `window:set-material` IPC（channels/contract/preload/handler） |
| `33676374` | 修复轮：补 handler 聚焦测试（人类裁定，超出原文件清单） |
| `af14f4ff` | renderer 接线（属性写入 / Provider / `main.css` shell 规则 / 文案函数） |
| `65086ddf` | 外观页「窗口背景」开关 + 恢复默认文案 |
| `e5d3cc80` | 启动遮罩去底色 + 卸载时机状态机 |
| `d3b0dca8` | 修复：Windows 玻璃外壳在「应用主题 ≠ 系统主题」时按应用主题染色（实机反馈） |
| `20bc6740` | 修复：renderer 重载后与主进程材质状态对账（重引入只读 `window:get-material`） |
| `6f613d20` | 修复：偏好存储注释/读取告警校正，补 `windowMaterial=null` 分支测试 |

## 2. 关键决策与实现期偏差

计划第 2 版的决策（D1-D11）按原样落地。相对计划文本的实现期偏差（均已过审查）：

1. **`StartupOverlayClock` 类型收窄**：计划用 `typeof setTimeout` 会触发 TS2741（Node 类型带 `__promisify__`），改为显式函数签名；默认 clock 在调用期解析全局 `setTimeout`，`vi.useFakeTimers()` 仍有效。
2. **新增 `window-controls/ipc.test.ts`**：计划未列此文件；经人类当场裁定补上 handler 的三条聚焦用例。
3. **重引入只读 `window:get-material`**：计划第 2 版以 YAGNI 删除，但整分支审查发现 renderer 崩溃 reload / dev Ctrl+R 后 argv 快照陈旧会导致「实际材质 / 落盘偏好 / 开关显示」不一致；重引入后 Provider 在挂载时对账一次，该接口有了真实消费者。
4. **Windows 玻璃外壳改为条件染色**：计划第 2 版 Windows/Linux 玻璃档 `--shell` 全透明；实机反馈「应用切深色后玻璃区不变暗」（Windows Acrylic 背板跟随**系统**主题）。现在仅在「应用主题与系统主题不一致」时用 `@media (prefers-color-scheme)` 叠主题色，一致时保持全透明（材质观感不变）。
5. **`applyMainWindowMaterial` 补测试**：计划未配测试，任务审查后补齐 5 个用例。

## 3. 验证证据

| 项目 | 命令 / 方式 | 结果 |
| --- | --- | --- |
| 基线（改动前） | `pnpm --filter @vykor/desktop exec vitest run` | 183 文件 / 1107 用例全绿 |
| 全量单测（修复波后） | 同上 | **190 文件 / 1168 用例全绿** |
| 类型检查 | `pnpm --filter @vykor/desktop typecheck` | `typecheck:node` + `typecheck:web` 通过 |
| 构建 | `pnpm --filter @vykor/desktop build` | `verify-workspace-boundaries.mjs` + typecheck + `electron-vite build` 通过（修复波后复跑） |
| 任务级审查 | 8 个任务各一轮独立审查 | 无未解决的 Critical/Important；2 个任务各 1 轮修复后通过 |
| 整分支最终审查 | base `d2285157`..head `e5d3cc80` | 结论「修完再合」：C1（实机裁决）+ I1（重载陈旧）+ M1/M3/M4 |
| 修复波定向复审 | base `e5d3cc80`..head `6f613d20` | 6 条发现全部 ADDRESSED，无新 Critical/Important |
| Windows 实机验收 | `pnpm --filter @vykor/desktop dev`（用户执行） | **材质可见、玻璃效果正常**；深浅色主题修复后复验通过 |

实机环境：Windows 11 `10.0.26200`，`AppsUseLightTheme=1`、`EnableTransparency=1`，Electron 39.8.10。

## 4. 已知限制与遗留项

- **macOS / Linux 未验证**（本机只有 Windows）：macOS 的 `vibrancy` 外观、Linux 透明窗口的可缩放性与无合成器表现均未实机确认。
- **macOS 运行期切玻璃丢 `visualEffectState: "active"`**：该选项是构造期选项（Electron 39 无 setter），运行期 `setVibrancy()` 后失焦会变灰暗；代码注释已披露。
- **macOS 标题栏几何未动**：计划 §3.2 的 `hiddenInset → hidden` + 随缩放重算（`setWindowButtonPosition`）属不可验证改动，留作后续。
- **`prefersReducedTransparency` 运行中变化不更新**：只在建窗与切换开关时读取（`nativeTheme.on("updated")` 不覆盖该值），D9 已知限制。
- **重载对账只在挂载时**：多窗口互相改材质不会互相通知（当前只有主窗口有开关）；dev StrictMode 下会多发一次只读 IPC（`disposed` 已防错）。
- **连续两次切换存在理论竞态**：主进程 handler 同步 + IPC 响应 FIFO，实际不可达。
- **正向 argv 链路无自动化测试**：`window.test.ts` 按计划禁改，主进程注入四个参数 → preload 快照的路径靠实机 DevTools 与任务 6 的单测（无参数→null）间接覆盖。
- **延后 minor（整分支审查已逐条甄别，无一条必须合并前修）**：测试覆盖缺口（`webContents.isDestroyed()` / `closed` 清理 / `unref`、startup-overlay 防冒泡与 cleanup、点已选中项、fixture 重复）；代码/文档小瑕疵（`PREFERENCES`/`ACTIVE_VALUES` 重复、`readArgument` first-wins 未定义、`process.platform` 取用两次、启动遮罩注释与实现漂移）；偏好文件损坏时回退默认并打一条 warn。

## 5. 后续建议

1. macOS / Linux 上补一次同类实机验收（重点：vibrancy 观感、Linux 透明窗口缩放）。
2. 关注 Electron 的 Windows `backgroundMaterial` 修复进展；若未来不再要求 `transparent`，可评估把 Mica 作为低端 GPU 的省电档位（材质名已收敛在 `WINDOWS_WINDOW_MATERIAL`）。
3. 合并回 `main` 后，把计划文件（当前在主工作区未跟踪）一并归档到 `docs/superpowers/plans/`。

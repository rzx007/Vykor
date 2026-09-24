# 归档：TUI 迁移 ink → opentui 实施计划

> 历史实施计划，禁止作为当前任务执行。计划中的 BackendHost/LegacyJSON 三进程模型已退场；当前架构见 [../../tui-flow.md](../../tui-flow.md) 和 [../../client-sync-flow.md](../../client-sync-flow.md)。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `apps/frontend` 从 ink + React 18 迁移到 `@opentui/react`，交互全面对齐 opencode（spec：`docs/superpowers/specs/2026-06-12-opentui-migration-design.md`）。

**Architecture:** 三进程模型不变（CLI 启动器 → 前端 TUI → Node BackendHost，LegacyJSON/stdio）。前端进程改由 Bun 运行；组件层按 opencode 架构重建（routes/Home+Session、栈式 Dialog、命令注册表、textarea Prompt），`useBackendSession`/协议/后端零改动。

**Tech Stack:** Bun、@opentui/core 0.4.x、@opentui/react 0.4.x、React 19（@opentui/react peer 要求 ≥19.2，Task 0 实测）、bun test（前端测试，替代 vitest）。

**Task 0 冒烟结论（2026-06-12，已通过）：** Windows + Bun 1.3.10 下 `@opentui/core-win32-x64` 原生 DLL 正常加载；Bun spawn Node + piped stdio + readline 链路正常。两个修正已并入下文：① React 必须 19（18 会报 `ReactSharedInternals.S` 错误）；② 组件测试统一用 `@opentui/react/test-utils` 的 `testRender(node, options)`（createRoot + renderOnce 有异步 commit 时序问题）；③ `@opentui/react` 无顶层 `render` 导出，入口用 `createRoot(renderer).render(...)`。冒烟产物在 `D:\tmp\opentui-smoke` 可参考。

**通用约定：**

- 工作目录：仓库根（worktree）。前端包目录 `apps/frontend`。
- opentui 原生渲染器**只能在 Bun 下跑**，前端所有测试用 `bun test`（jest 风格 API，`import { test, expect } from "bun:test"`），不要用 vitest。React 组件测试用 `import { testRender } from "@opentui/react/test-utils"`（返回 renderer/renderOnce/captureCharFrame/mockInput 等，规避 createRoot 异步 commit 时序问题）；后文测试代码片段中的 `createTestRenderer + createRoot` 写法一律按此替换。
- 每个任务结束跑 `pnpm --filter @vykor/frontend check-types`（build/test 不查类型，这是本仓已知坑）。
- 提交信息末尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- opentui API 参考：本机 skill 文档 `C:\Users\ruanz\.claude\skills\opentui\docs\`（components/、bindings/react.mdx、core-concepts/testing.mdx）。交互参考源码（已克隆）：`$TEMP/opencode-ref/packages/tui/src/`（Solid 实现，只抄交互语义不抄代码）。
- React JSX 内置元素全小写：`<box>` `<text>` `<scrollbox>` `<textarea>` `<input>` `<select>` `<markdown>` `<code>` `<span>`。颜色一律用 hex 字符串。

---

### Task 0：冒烟验证（风险门，不通过则停止）

**Files:** 全部在临时目录（如 `D:/tmp/opentui-smoke`），不进仓库。

- [ ] **Step 1: 验证 Bun 已安装**

Run: `bun --version`
Expected: 输出版本号（如 1.x）。若无 bun：`powershell -c "irm bun.sh/install.ps1 | iex"` 后重试。

- [ ] **Step 2: opentui hello-world（Windows 原生库验证）**

```bash
mkdir -p /d/tmp/opentui-smoke && cd /d/tmp/opentui-smoke
bun init -y
bun add @opentui/core@0.4.1 @opentui/react@0.4.1 react@18
```

写 `hello.tsx`：

```tsx
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";

function App() {
  return (
    <box border padding={1} flexDirection="column">
      <text fg="#7aa2f7">opentui smoke OK — press ctrl+c</text>
    </box>
  );
}

const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(<App />);
```

`tsconfig.json` 的 compilerOptions 加 `"jsx": "react-jsx", "jsxImportSource": "@opentui/react"`。

Run: `bun hello.tsx`（需要真实 TTY，在终端手工跑）
Expected: 渲染出带边框的蓝色文字，ctrl+c 正常退出。失败（FFI 加载错误/找不到原生二进制）→ **停止，回报用户重新评估**。

- [ ] **Step 3: Bun 前端 spawn Node 后端 + piped stdio 验证**

写 `spawn-test.ts`：

```ts
import { spawn } from "node:child_process";
import readline from "node:readline";

const child = spawn(process.execPath.includes("bun") ? "node" : process.execPath,
  ["-e", "console.log('LegacyJSON:{\"type\":\"ready\"}'); process.stdin.on('data', d => { console.log('LegacyJSON:{\"type\":\"echo\"}'); process.exit(0); });"],
  { stdio: ["pipe", "pipe", "inherit"] });
const reader = readline.createInterface({ input: child.stdout! });
reader.on("line", (line) => {
  console.error("got:", line);
  if (line.includes("ready")) child.stdin!.write("hello\n");
});
child.on("exit", (code) => { console.error("exit", code); process.exit(0); });
```

Run: `bun spawn-test.ts`
Expected: stderr 依次输出 `got: LegacyJSON:{"type":"ready"}`、`got: LegacyJSON:{"type":"echo"}`、`exit 0`。这验证了 useBackendSession 的核心链路（node:child_process + readline）在 Bun 下可用。

- [ ] **Step 4: 测试渲染器验证**

写 `frame-test.test.tsx`：

```tsx
import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";

test("frame snapshot works", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 40, height: 5 });
  createRoot(renderer).render(<text>hello frame</text>);
  await renderOnce();
  expect(captureCharFrame()).toContain("hello frame");
  renderer.destroy();
});
```

Run: `bun test frame-test.test.tsx`
Expected: PASS。

- [ ] **Step 5: 记录结论**

冒烟全过 → 在 PR/会话中记录"Windows + Bun + opentui 0.4.1 冒烟通过"，删除临时目录，继续 Task 1。任一步失败 → 停止并回报。

---

### Task 1：依赖与构建切换

**Files:**
- Modify: `pnpm-workspace.yaml`（catalog）
- Modify: `apps/frontend/package.json`
- Modify: `apps/frontend/tsconfig.json`
- Modify: `apps/frontend/build.ts`

- [ ] **Step 1: catalog 增删**

`pnpm-workspace.yaml` catalog 中**新增**：

```yaml
  '@opentui/core': ^0.4.1
  '@opentui/react': ^0.4.1
```

并把 `react` 改为 `^19.2.0`、`@types/react` 改为 `^19.0.0`（全仓只有 frontend 引用 react，已确认无他包受影响）。保留 `ink`/`ink-text-input`（catalog 删除会影响 lockfile 一致性，等 Task 13 清理时一并删）。

- [ ] **Step 2: frontend package.json**

dependencies：删 `ink`、`ink-text-input`；加 `"@opentui/core": "catalog:"`、`"@opentui/react": "catalog:"`。删 `marked`、`cli-highlight`、`string-width`（被 opentui `<markdown>` 取代；若其他文件仍引用，等删除任务后再清也可，但目标是本任务后 `pnpm install` 干净）。
devDependencies：删 `ink-testing-library`、`vitest`。
scripts：`"test": "bun test src"`。

- [ ] **Step 3: tsconfig 加 jsxImportSource**

```json
"jsx": "react-jsx",
"jsxImportSource": "@opentui/react"
```

- [ ] **Step 4: build.ts target 改 bun**

`target: "node"` → `target: "bun"`；shebang 行 `#!/usr/bin/env node` → `#!/usr/bin/env bun`。

- [ ] **Step 5: 安装并提交**

Run: `pnpm install`
Expected: 成功。此刻 src 还是 ink 代码，**不要跑 build/check-types**（必红）。

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml apps/frontend/package.json apps/frontend/tsconfig.json apps/frontend/build.ts
git commit --no-verify -m "build(frontend): 依赖切换 ink → opentui，运行时 Node → Bun"
```

（本次允许 `--no-verify`：中间态类型必然不过，Task 11 起恢复钩子验证。）

---

### Task 2：主题适配（hex 化 + SyntaxStyle）

**Files:**
- Modify: `apps/frontend/src/theme/builtinThemes.ts`
- Create: `apps/frontend/src/theme/syntax.ts`
- Test: `apps/frontend/src/theme/syntax.test.ts`

- [ ] **Step 1: builtinThemes 颜色 hex 化**

opentui 颜色用 hex。把 `ThemeConfig.colors` 的命名色换成 hex（两套主题都换），如 default 主题：`primary: "#56b6c2"`、`secondary: "#abb2bf"`、`accent: "#61afef"`、`foreground: "#abb2bf"`、`background: "#1e2127"`、`muted: "#5c6370"`、`success: "#98c379"`、`warning: "#e5c07b"`、`error: "#e06c75"`、`info: "#61afef"`。另增 `colors.backgroundPanel: string`（输入框/弹层底色，default 用 `#262a33`），同步更新 ThemeConfig 类型与所有内置主题。

- [ ] **Step 2: 写失败测试（syntax.ts）**

```ts
import { test, expect } from "bun:test";
import { createSyntaxStyle } from "./syntax";
import { defaultTheme } from "./builtinThemes";

test("createSyntaxStyle returns a SyntaxStyle with theme colors", () => {
  const style = createSyntaxStyle(defaultTheme);
  expect(style).toBeDefined();
});
```

Run: `cd apps/frontend && bun test src/theme` → Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 syntax.ts**

```ts
import { SyntaxStyle, RGBA } from "@opentui/core";
import type { ThemeConfig } from "./builtinThemes";

/** 由主题色生成 <markdown>/<code> 用的 SyntaxStyle。 */
export function createSyntaxStyle(theme: ThemeConfig): SyntaxStyle {
  const c = theme.colors;
  return SyntaxStyle.fromStyles({
    "markup.heading.1": { fg: RGBA.fromHex(c.primary), bold: true },
    "markup.heading": { fg: RGBA.fromHex(c.primary), bold: true },
    "markup.list": { fg: RGBA.fromHex(c.accent) },
    "markup.raw": { fg: RGBA.fromHex(c.warning) },
    "markup.bold": { fg: RGBA.fromHex(c.foreground), bold: true },
    "markup.italic": { fg: RGBA.fromHex(c.foreground), italic: true },
    "markup.link.url": { fg: RGBA.fromHex(c.info), underline: true },
    comment: { fg: RGBA.fromHex(c.muted), italic: true },
    string: { fg: RGBA.fromHex(c.success) },
    keyword: { fg: RGBA.fromHex(c.accent) },
    function: { fg: RGBA.fromHex(c.info) },
    number: { fg: RGBA.fromHex(c.warning) },
    type: { fg: RGBA.fromHex(c.primary) },
    default: { fg: RGBA.fromHex(c.foreground) },
  });
}
```

- [ ] **Step 4: 跑测试通过后提交**

Run: `bun test src/theme` → PASS。
ThemeContext.tsx 不动（纯 React，无 ink 依赖）。

```bash
git add -A apps/frontend/src/theme && git commit --no-verify -m "feat(frontend): 主题 hex 化 + SyntaxStyle 生成器"
```

---

### Task 3：入口与最小可运行骨架

**Files:**
- Modify: `apps/frontend/src/index.tsx`
- Modify: `apps/frontend/src/App.tsx`（整文件替换为骨架，后续任务填充）
- Modify: `apps/frontend/src/types/index.ts`（FrontendConfig 加 `theme?`/`version?`）

- [ ] **Step 1: types 扩展**

`FrontendConfig` 加 `theme?: string | null; version?: string | null;`（index.tsx 现在用交叉类型 hack，顺手收编）。

- [ ] **Step 2: index.tsx 重写**

```tsx
/**
 * TUI 前端入口（进程 B，Bun 运行时）。配置经 VYKOR_FRONTEND_CONFIG 注入；
 * backend 由 useBackendSession spawn。详见 docs/tui-flow.md。
 */
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./App";
import type { FrontendConfig } from "./types";

const rawConfig = process.env.VYKOR_FRONTEND_CONFIG;
let config: FrontendConfig;
try {
  const parsed = rawConfig ? JSON.parse(rawConfig) : {};
  config = {
    backend_command: parsed.backend_command
      ?? (process.env.VYKOR_BACKEND_COMMAND?.split(" ") ?? ["vk", "--backend-only"]),
    initial_prompt: parsed.initial_prompt ?? process.env.VYKOR_INITIAL_PROMPT ?? null,
    theme: parsed.theme ?? process.env.VYKOR_THEME ?? "default",
    version: parsed.version ?? null,
  };
} catch {
  config = { backend_command: ["vk", "--backend-only"], theme: "default" };
}

try {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  createRoot(renderer).render(<App config={config} />);
} catch (err) {
  console.error("[vykor] 终端渲染器初始化失败（需要 Bun + 支持的平台）：", err);
  process.exit(1);
}
```

- [ ] **Step 3: App.tsx 替换为骨架**

保留 `ThemeProvider` 包裹与 `useBackendSession` 调用；UI 仅渲染：未 ready 时 `<text fg={theme.colors.warning}>Connecting to backend...</text>`，ready 后 `<text>ready: {session.transcript.length} items</text>`。`useKeyboard` 处理 ctrl+c：`key.ctrl && key.name === "c"` → `session.sendRequest({ type: "shutdown" })` + `renderer.destroy()` + `process.exit(0)`（经 `useRenderer()` 取 renderer）。旧 App 逻辑（handleCommand、picker、modal 等）整段删除——后续任务按新架构重建，不要保留死代码。

- [ ] **Step 4: 手工验证 + 提交**

Run: `cd apps/frontend && bun run build && cd ../.. && node apps/cli/dist/... ` 不可行（CLI 还没改）。改用 dev 直跑：
`cd apps/frontend && VYKOR_BACKEND_COMMAND="node ../cli/dist/index.js --backend-only" bun src/index.tsx`（若 cli 未 build，先 `pnpm --filter @vykor/cli build`；backend 失败也至少应看到 Connecting 文案）。
Expected: 屏幕出现 Connecting/ready 文案，ctrl+c 退出。
Run: `pnpm --filter @vykor/frontend check-types` → 仍会因旧组件报错，可暂忽略（本任务只保证 index/App/types/theme 无错：`bunx tsc --noEmit src/index.tsx` 不可行，靠下一任务批量删旧文件后收敛）。

```bash
git add -A apps/frontend/src && git commit --no-verify -m "feat(frontend): opentui 入口 + App 骨架"
```

---### Task 4：删除旧 ink 组件与旧测试

**Files:**
- Delete: `apps/frontend/src/components/`（整个目录：Markdown.tsx、markdownParser.ts、ConversationView.tsx、ModalHost.tsx、SelectModal.tsx、PromptInput.tsx、Spinner.tsx、CommandPicker.tsx、StatusBar.tsx、TodoPanel.tsx、SwarmPanel.tsx、ToolCallDisplay.tsx、WelcomeBanner.tsx 及全部 `*.test.*`）
- Modify: `apps/frontend/vitest 残留`（若 vitest.config 引用 frontend，从根 vitest.config.ts 排除该包）

- [ ] **Step 1: 删除目录**

```bash
git rm -r apps/frontend/src/components
```

旧组件的可复用逻辑（TodoPanel 的 parseTodoItems、SwarmPanel 的图标/时长格式化、StatusBar 的字段读取）在重建任务里按需从 git 历史抄回。

- [ ] **Step 2: 类型收敛验证**

Run: `pnpm --filter @vykor/frontend check-types`
Expected: PASS（只剩 index/App/hooks/theme/types）。

- [ ] **Step 3: 检查根 vitest 配置**

`vitest.config.ts` 若以 glob 收集 `apps/*`，确认不会再扫到 frontend 测试（components 已删，无 `.test` 文件即可）；`pnpm test` 全仓跑一遍确认绿。

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(frontend): 移除 ink 组件层（opentui 重建前清场）"
```

（此后钩子应能过，不再用 --no-verify。）

---

### Task 5：Dialog 栈 + Toast

**Files:**
- Create: `apps/frontend/src/ui/DialogContext.tsx`
- Create: `apps/frontend/src/ui/Toast.tsx`
- Test: `apps/frontend/src/ui/DialogContext.test.tsx`

- [ ] **Step 1: 失败测试**

```tsx
import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { DialogProvider, useDialog } from "./DialogContext";

test("dialog renders above content when pushed", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 60, height: 20 });
  let api: ReturnType<typeof useDialog> | null = null;
  function Capture() { api = useDialog(); return null; }
  createRoot(renderer).render(
    <DialogProvider><Capture /><text>base layer</text></DialogProvider>,
  );
  await renderOnce();
  expect(captureCharFrame()).toContain("base layer");
  api!.push(<text>dialog content</text>);
  await renderOnce();
  expect(captureCharFrame()).toContain("dialog content");
  api!.close();
  await renderOnce();
  expect(captureCharFrame()).not.toContain("dialog content");
  renderer.destroy();
});
```

Run: `bun test src/ui` → FAIL（模块不存在）。

- [ ] **Step 2: 实现 DialogContext.tsx**

```tsx
import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useTheme } from "../theme/ThemeContext";

type DialogEntry = { node: React.ReactNode; onClose?: () => void };

export type DialogApi = {
  push: (node: React.ReactNode, onClose?: () => void) => void;
  /** 关掉整栈再压入（命令面板等互斥弹层用）。 */
  replace: (node: React.ReactNode, onClose?: () => void) => void;
  close: () => void;
  closeAll: () => void;
  isOpen: boolean;
};

const DialogContext = createContext<DialogApi | null>(null);

export function useDialog(): DialogApi {
  const api = useContext(DialogContext);
  if (!api) throw new Error("useDialog must be used within DialogProvider");
  return api;
}

export function DialogProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [stack, setStack] = useState<DialogEntry[]>([]);
  const { width, height } = useTerminalDimensions();
  const { theme } = useTheme();

  const close = useCallback(() => {
    setStack((s) => {
      s[s.length - 1]?.onClose?.();
      return s.slice(0, -1);
    });
  }, []);

  const api = useMemo<DialogApi>(() => ({
    push: (node, onClose) => setStack((s) => [...s, { node, onClose }]),
    replace: (node, onClose) => setStack(() => [{ node, onClose }]),
    close,
    closeAll: () => setStack((s) => { s.forEach((e) => e.onClose?.()); return []; }),
    isOpen: stack.length > 0,
  }), [close, stack.length]);

  // esc 关顶层：在 Provider 层兜底（具体 dialog 可先行消费按键）。
  useKeyboard((key) => {
    if (stack.length > 0 && key.name === "escape") close();
  });

  const top = stack[stack.length - 1];
  const dialogWidth = Math.min(64, Math.max(40, Math.floor(width * 0.6)));

  return (
    <DialogContext.Provider value={api}>
      {children}
      {top ? (
        <box
          position="absolute"
          left={Math.max(0, Math.floor((width - dialogWidth) / 2))}
          top={Math.max(1, Math.floor(height / 4))}
          width={dialogWidth}
          zIndex={100}
          border
          borderColor={theme.colors.accent}
          backgroundColor={theme.colors.backgroundPanel}
          padding={1}
          flexDirection="column"
        >
          {top.node}
        </box>
      ) : null}
    </DialogContext.Provider>
  );
}
```

注：`position="absolute"`/`zIndex` 为 opentui Box 属性；若属性名不符（以 `docs/components/box.mdx` 为准），执行时查文档修正。

- [ ] **Step 3: Toast.tsx**

同模式实现 `ToastProvider`/`useToast`：`toast(message, level?: "info"|"error", ttlMs = 3000)` 压入数组，`setTimeout` 到期移除；渲染为右上角 `position="absolute"` 列（`right` 对齐用 `left: width - toastWidth - 1`），边框色按 level 取 info/error 主题色。给 `useToast` 写一条同款帧测试（出现 + 到期消失，用 `waitForFrame`）。

- [ ] **Step 4: 测试通过 + 提交**

Run: `bun test src/ui` → PASS。

```bash
git add -A apps/frontend/src/ui && git commit -m "feat(frontend): 栈式 Dialog + Toast（opentui）"
```

---

### Task 6：DialogSelect 通用选择器

**Files:**
- Create: `apps/frontend/src/ui/fuzzy.ts`（纯函数，单测主体）
- Create: `apps/frontend/src/ui/DialogSelect.tsx`
- Test: `apps/frontend/src/ui/fuzzy.test.ts`、`apps/frontend/src/ui/DialogSelect.test.tsx`

- [ ] **Step 1: fuzzy.ts 失败测试**

```ts
import { test, expect } from "bun:test";
import { fuzzyFilter } from "./fuzzy";

const items = ["/theme", "/permissions", "/plan", "/help"];

test("empty query keeps order", () => {
  expect(fuzzyFilter(items, "", (s) => s)).toEqual(items);
});
test("subsequence match + prefix优先", () => {
  expect(fuzzyFilter(items, "/p", (s) => s)).toEqual(["/permissions", "/plan"]);
  expect(fuzzyFilter(items, "pln", (s) => s)).toEqual(["/plan"]);
});
test("no match returns empty", () => {
  expect(fuzzyFilter(items, "zzz", (s) => s)).toEqual([]);
});
```

- [ ] **Step 2: 实现 fuzzyFilter**

`fuzzyFilter<T>(items: T[], query: string, key: (t: T) => string): T[]`——大小写不敏感子序列匹配；得分 = 连续命中加分 + 前缀命中加大分，按分排序，稳定保序。约 30 行。Run → PASS。

- [ ] **Step 3: DialogSelect.tsx**

Props：

```tsx
export type DialogSelectItem = {
  value: string; label: string; description?: string;
  category?: string; hint?: string; active?: boolean;
};
export function DialogSelect(props: {
  title: string;
  items: DialogSelectItem[];
  onSelect: (value: string) => void;
  searchable?: boolean;        // 默认 true
  initialIndex?: number;
}): React.JSX.Element;
```

实现要点：顶部 `<input focused>`（searchable 时）驱动 `fuzzyFilter`；列表区高度上限 10 行，超出滚动（用 `<scrollbox>` + `scrollChildIntoView` 或手工窗口切片，取简单的切片实现）；`useKeyboard` 处理 ↑↓（移动 selectedIndex）、enter（onSelect 当前项）、数字 1-9 直选（仅 searchable=false 时，避免与搜索输入冲突）；当前行高亮（`backgroundColor=theme.colors.accent` + 前景反白）；`active` 项加 ✓ 前缀；`hint`（如快捷键）右对齐淡色。onSelect 内**不**负责关 dialog，由调用方决定（便于多级选择）。

- [ ] **Step 4: 帧测试**

测：渲染 title 与全部 item；mockInput 输入查询后列表收窄（用 `createTestRenderer` 的 `mockInput.typeText("pl")` + `waitForFrame`）；↓+enter 触发 onSelect 正确 value。
Run: `bun test src/ui` → PASS。

- [ ] **Step 5: Commit**

```bash
git add -A apps/frontend/src/ui && git commit -m "feat(frontend): DialogSelect 模糊搜索选择器"
```

---

### Task 7：命令注册表

**Files:**
- Create: `apps/frontend/src/keymap/commands.ts`
- Test: `apps/frontend/src/keymap/commands.test.ts`

- [ ] **Step 1: 失败测试**

```ts
import { test, expect } from "bun:test";
import { buildRegistry } from "./commands";

test("merges backend slash commands with local commands", () => {
  const reg = buildRegistry({
    backendCommands: ["/help", "/theme"],
    local: [{ id: "app.exit", title: "Exit", keybinding: "ctrl+c", run: () => {} }],
    submitLine: () => {},
  });
  const ids = reg.all().map((c) => c.id);
  expect(ids).toContain("/help");
  expect(ids).toContain("app.exit");
});

test("backend command run() submits the slash line", () => {
  const lines: string[] = [];
  const reg = buildRegistry({ backendCommands: ["/help"], local: [], submitLine: (l) => lines.push(l) });
  reg.get("/help")!.run();
  expect(lines).toEqual(["/help"]);
});

test("slashCommands() only returns slash-prefixed entries", () => {
  const reg = buildRegistry({
    backendCommands: ["/help"],
    local: [{ id: "app.exit", title: "Exit", run: () => {} }],
    submitLine: () => {},
  });
  expect(reg.slashCommands().map((c) => c.id)).toEqual(["/help"]);
});
```

- [ ] **Step 2: 实现**

```ts
export type Command = {
  id: string;            // 斜杠命令用原文（"/help"），本地命令用 "app.xxx"
  title: string;         // 面板展示名
  keybinding?: string;   // 仅展示用 hint（按键派发在 App 层）
  run: () => void;
};

export type CommandRegistry = {
  all: () => Command[];
  get: (id: string) => Command | undefined;
  slashCommands: () => Command[];
};

export function buildRegistry(opts: {
  backendCommands: string[];
  local: Command[];
  submitLine: (line: string) => void;
}): CommandRegistry { /* backend 命令包装成 run=()=>submitLine(id)，与 local 合并去重（local 优先） */ }
```

- [ ] **Step 3: PASS + Commit**

```bash
git add -A apps/frontend/src/keymap && git commit -m "feat(frontend): 命令注册表（后端斜杠命令 + 本地命令统一）"
```

---

### Task 8：Logo + Home 路由

**Files:**
- Create: `apps/frontend/src/components/Logo.tsx`
- Create: `apps/frontend/src/routes/Home.tsx`
- Test: `apps/frontend/src/routes/Home.test.tsx`

- [ ] **Step 1: Logo.tsx**

用 `<ascii-font>`（参考 `docs/components/ascii-font.mdx` 选可用字体）渲染 `vykor`；终端窄于 logo 宽度时回退为普通 `<text bold>`。前景 `theme.colors.foreground`，副词缀（如 "code"）可用 `theme.colors.muted` 分段——照 opencode 截图双色风格：`open` 用 muted、`harness` 用 foreground。

- [ ] **Step 2: Home.tsx**

布局（flexDirection column，整屏居中）：

```
[flexGrow 空白]
[Logo 居中]
[1 行空白]
[children —— App 会把 <Prompt> 作为 children 传进来，宽度 60% 上限 80 列居中]
[提示行: "tab mode   ctrl+p commands" 右对齐淡色（本应用 tab 切权限模式，不照抄 opencode 的 "tab agents"）]
[flexGrow 空白]
[Footer 由 App 统一渲染，不在 Home 内]
```

Props：`{ children: React.ReactNode }`。

- [ ] **Step 3: 帧测试**

渲染 Home（children 传 `<text>PROMPT</text>`），断言 frame 含 logo 字样（或回退文本）、`ctrl+p commands`、`PROMPT`。
Run: `bun test src/routes` → PASS。

- [ ] **Step 4: Commit**

```bash
git add -A apps/frontend/src/components apps/frontend/src/routes && git commit -m "feat(frontend): Logo + Home 首页路由"
```

---

### Task 9：Prompt（textarea）+ 斜杠自动补全

**Files:**
- Create: `apps/frontend/src/components/prompt/Prompt.tsx`
- Create: `apps/frontend/src/components/prompt/Autocomplete.tsx`
- Test: `apps/frontend/src/components/prompt/Prompt.test.tsx`

- [ ] **Step 1: Prompt.tsx 接口与布局**

```tsx
export type PromptProps = {
  busy: boolean;
  placeholder?: string;            // 默认 'Ask anything... "Fix broken tests"'
  mode: string;                    // permission_mode: default/full_auto/plan
  model: string;                   // status.model
  effort?: string;                 // status.effort（有才显示，对应截图 "high"）
  history: string[];
  slashCommands: Command[];        // 来自注册表
  onSubmit: (line: string) => void;
  onCycleMode: () => void;         // tab
};
```

视觉（对齐 opencode 截图）：外层 `<box>` 左侧 2 列宽 accent 色竖条（用嵌套 box：左侧 `width:1, backgroundColor: accent`，右侧内容区 `backgroundColor: backgroundPanel, padding 1`）。内容区两行结构：`<textarea>`（height 随内容 1-6 行，初始 1）+ 元信息行 `<text>`：`{modeLabel}` accent 色 · `{model}` 前景色 · `{effort}` warning 色。busy 时元信息行换成 spinner 帧 + 当前工具名（spinner 用 `useEffect` 定时器轮换 `theme.icons.spinner` 帧）。

- [ ] **Step 2: 键盘与提交语义**

textarea 配置：`keyBindings: [{ name: "return", action: "submit" }, { name: "return", shift: true, action: "newline" }]`，`onSubmit` 读 `ref.plainText`，trim 空不提交；提交后 `ref.clear()`（无此方法则 `setSelection(0, len)` + `deleteSelection()`，执行时查 `docs/components/textarea.mdx`）。
`useKeyboard` 在 Prompt 内处理：`tab` → onCycleMode（仅当 autocomplete 未打开）；↑/↓ → 文本为空时翻 history（写回 textarea），否则交给 textarea 移动光标——判断依据 `ref.plainText === ""`；esc → 清空输入。busy 时 textarea 不聚焦、忽略提交。

- [ ] **Step 3: Autocomplete.tsx**

输入以 `/` 开头且非 busy 时显示：Prompt 上方 `position="absolute"` 浮窗，`fuzzyFilter(slashCommands, 当前词)` 取前 8 条；↑↓ 选择、tab 补全到输入框、enter 直接执行（run()）、esc 关闭。监听 textarea `onContentChange` 同步 query。复用 Task 6 的 fuzzy 与高亮样式。

- [ ] **Step 4: 帧测试**

- 渲染含 placeholder 的 Prompt，frame 含 placeholder 与 mode/model 行。
- `mockInput.typeText("/th")` → frame 出现 `/theme` 补全项；`mockInput.pressKey("return")` → run 被调用。
- `mockInput.typeText("hello")` + enter → onSubmit 收到 "hello" 且输入清空。

Run: `bun test src/components/prompt` → PASS。

- [ ] **Step 5: Commit**

```bash
git add -A apps/frontend/src/components/prompt && git commit -m "feat(frontend): textarea Prompt + 斜杠命令自动补全"
```

---

### Task 10：Session 消息流 + Footer + Todo/Swarm 面板

**Files:**
- Create: `apps/frontend/src/routes/session/parts.tsx`
- Create: `apps/frontend/src/routes/session/Session.tsx`
- Create: `apps/frontend/src/routes/session/Footer.tsx`
- Create: `apps/frontend/src/components/TodoPanel.tsx`、`apps/frontend/src/components/SwarmPanel.tsx`
- Test: `apps/frontend/src/routes/session/Session.test.tsx`

- [ ] **Step 1: parts.tsx —— TranscriptItem 渲染器**

`export function TranscriptPart({ item, syntax }: { item: TranscriptItem; syntax: SyntaxStyle })`：

- `user`：`<text>` 前缀 `theme.icons.user`，accent 色，整块左缩进。
- `assistant`：`<markdown content={item.text} syntaxStyle={syntax}>`。
- `tool`：一行 `<text>`：muted 色 `theme.icons.tool` + tool_name bold + 关键入参摘要（从 `tool_input` 取 command/file_path/pattern 等首个存在键，截断 60 列）——逻辑从 git 历史 `ToolCallDisplay.tsx` 抄。
- `tool_result`：默认折叠为一行 `└ {首行，截断}`（is_error 时 error 色 + 全文）。
- `system`/`log`：muted 色一行。

- [ ] **Step 2: Session.tsx**

```tsx
<scrollbox flexGrow={1} stickyScroll stickyStart="bottom"
  verticalScrollbarOptions={{ trackOptions: { foregroundColor: theme.colors.muted, backgroundColor: theme.colors.backgroundPanel } }}>
  {items.map((item, i) => <TranscriptPart key={i} item={item} syntax={syntax} />)}
  {assistantBuffer ? <markdown content={assistantBuffer} syntaxStyle={syntax} streaming /> : null}
</scrollbox>
```

Props：`{ items, assistantBuffer }`。syntax 用 `useMemo(() => createSyntaxStyle(theme), [theme])`。

- [ ] **Step 3: Footer.tsx**

一行两端布局（外层 box `flexDirection="row" justifyContent="space-between"`）：
左：`{cwd}:{gitBranch}`（cwd 取 `process.cwd()` 截尾 40 列；branch 启动时读一次 `.git/HEAD`，非 git 目录不显示）。
右：`⊙ {mcpServers.length} MCP`（>0 success 色，有 error 状态的 server 则 error 色）· `/status` muted · `tokens {in}↓ {out}↑`（status.input_tokens/output_tokens，>0 才显示）· `{version}`（config.version，无则不显示）。
mode 为 plan 时左侧追加 warning 色 `[PLAN]`（语义沿用旧 StatusBar，简化掉闪烁动画）。

- [ ] **Step 4: TodoPanel / SwarmPanel 迁移**

从 git 历史抄回 `parseTodoItems`/图标/时长逻辑，渲染层翻译成 `<box>/<text>`，砍掉旧版 useInput 折叠交互（YAGNI，固定紧凑模式：Todo 显示 `▣ 3/7 当前项文本`，Swarm 每 teammate 一行）。

- [ ] **Step 5: 帧测试**

Session 渲染混合 transcript（user/assistant/tool/tool_result/system 各一）断言关键内容出现；assistantBuffer 流式块出现。
Run: `bun test src/routes` → PASS。

- [ ] **Step 6: Commit**

```bash
git add -A apps/frontend/src && git commit -m "feat(frontend): Session 消息流 + Footer + Todo/Swarm 面板"
```

---

### Task 11：App 整合（路由切换、dialog 接线、ctrl+p、按键总线）

**Files:**
- Modify: `apps/frontend/src/App.tsx`（骨架 → 完整）
- Test: `apps/frontend/src/App.test.tsx`

- [ ] **Step 1: Provider 栈与路由**

```
<ThemeProvider><DialogProvider><ToastProvider><AppInner/></ToastProvider></DialogProvider></ThemeProvider>
```

AppInner：`const route = transcript 无 user/assistant 项 && !busy ? "home" : "session"`。
home → `<Home><Prompt .../></Home>` + `<Footer/>`；
session → `<Session/>` + TodoPanel/SwarmPanel（条件渲染）+ `<Prompt/>` + `<Footer/>`。
未 ready → Connecting 文案。

- [ ] **Step 2: 命令注册表实例**

`useMemo` 构建：backendCommands = session.commands；local 命令：
- `app.palette`（ctrl+p）→ `dialog.replace(<CommandPalette/>)`；
- `app.cycleMode`（tab）→ 按 default→full_auto→plan→default 发 `/permissions set {next}`（沿用旧 handleCommand 语义：`submit_line` + setBusy）；
- `app.theme` → 打开 DialogSelect 列内置主题，选中即 `setThemeName`；
- `app.exit`（ctrl+c）→ shutdown + destroy + exit。
旧 App 的 `/theme set X`、`/permissions`、`/plan`、`/resume` 拦截逻辑迁移进对应 local 命令或 Prompt onSubmit 前置 handleCommand（保留原语义，`/permissions` 打开 DialogSelect 替代旧 SelectModal）。

CommandPalette = `<DialogSelect title="Commands" items={registry.all().map(...)} onSelect={(id)=>{ dialog.close(); registry.get(id)?.run(); }}/>`，hint 列显示 keybinding。

- [ ] **Step 3: 后端弹层接线（旧 ModalHost/SelectModal 语义平移）**

`useEffect` 监听 `session.modal`：
- `kind === "permission"` → `dialog.push(<PermissionDialog/>)`：显示 tool_name/detail，`useKeyboard` y/a/n（y=once、a=session、n/esc=拒绝），发 `permission_response` 后 `dialog.close()` + `session.setModal(null)`。onClose（esc 兜底）也要发拒绝，防止后端挂起。
- `kind === "question"` → `dialog.push(<QuestionDialog/>)`：`<input focused onSubmit>` 发 `question_response`。

监听 `session.selectRequest` → `dialog.push(<DialogSelect items=options onSelect={(v)=>{ sendRequest submit_line submitPrefix+v; setBusy(true); dialog.close(); }}/>)`，并 `setSelectRequest(null)`（沿用旧 useEffect 语义）。

- [ ] **Step 4: 全局按键**

`useKeyboard`：ctrl+c → app.exit；ctrl+p → app.palette；dialog 打开时不转发 tab/enter 给 Prompt（DialogProvider 的 esc 兜底已有）。注意 opentui 的 key 事件对象字段是 `key.name`/`key.ctrl`/`key.shift`。

- [ ] **Step 5: 帧测试**

- 初始（mock 后端不可行——useBackendSession 会真 spawn；把 AppInner 拆出接受 `session` prop 的纯渲染层 `AppView`，对 AppView 注入伪 session 对象做帧测试）：home 帧含 logo 与 placeholder。
- 注入含 user+assistant 的 transcript → session 帧含消息与 Footer。
- 注入 `modal={kind:"permission",...}` → 帧含权限对话框；`mockInput.pressKey("y")` 断言 sendRequest 收到 allowed:true scope:once。

**实现要求**：AppInner 拆成 `AppInner`（接 useBackendSession）+ `AppView`（纯 props），测试只测 AppView。

Run: `bun test src` → 全绿。

- [ ] **Step 6: 手工验证 + 提交**

`cd apps/frontend && VYKOR_BACKEND_COMMAND="node <repo>/apps/cli/dist/index.js --backend-only" bun src/index.tsx`
Expected: Home 界面 → 输入消息 → 切 Session、流式 markdown → tab 切模式 → ctrl+p 面板 → ctrl+c 退出。

```bash
git add -A apps/frontend && git commit -m "feat(frontend): App 整合 — 路由/dialog 接线/命令面板/按键总线"
```

---

### Task 12：CLI 改用 Bun 拉起前端

**Files:**
- Modify: `apps/cli/src/commands/main.ts`（runTuiMode，约 L628-685）
- Test: `apps/cli/src/commands/main.test.ts` 若存在则补；否则新建 `apps/cli/src/commands/resolveBun.test.ts`

- [ ] **Step 1: resolveBun 工具 + 失败测试**

在 main.ts 同目录新建 `resolveBun.ts`：

```ts
import { spawnSync } from "node:child_process";

/** 解析 bun 可执行文件。Windows 下必须带 .exe（libuv 不应用 PATHEXT）。 */
export function resolveBun(): string | null {
  const candidates = process.platform === "win32" ? ["bun.exe", "bun"] : ["bun"];
  for (const cmd of candidates) {
    const r = spawnSync(cmd, ["--version"], { stdio: "ignore" });
    if (r.error == null && r.status === 0) return cmd;
  }
  return null;
}
```

测试（vitest，cli 包测试栈不变）：`resolveBun()` 在装有 bun 的机器返回非 null；mock 不可测 PATH 缺失场景就只测正路径 + 类型。

- [ ] **Step 2: runTuiMode 改造**

```ts
const bun = resolveBun();
if (!bun) {
  console.error(
    "vykor TUI 需要 Bun 运行时（opentui 原生渲染器）。\n" +
    "安装：https://bun.sh — Windows: powershell -c \"irm bun.sh/install.ps1 | iex\"\n" +
    "或使用 --print 模式无 TUI 运行。",
  );
  process.exit(1);
}
// ...
const child = spawn(bun, [frontendDistPath], { stdio: "inherit", env: {...} });
```

frontendConfig 增加 `version`：从 cli 自身 package.json 读（main.ts 现有读取方式，若无则 `createRequire(import.meta.url)("../../package.json").version`）。
同步更新 runTuiMode 的 JSDoc（"React/Ink 前端" → "opentui 前端（Bun）"）与 `apps/cli/src/index.ts:35` 的 `--backend-only` 描述文案（"Ink frontend" → "TUI frontend"）。

- [ ] **Step 3: 构建 + 全链路手工验收**

```bash
pnpm build && pnpm check-types && pnpm test
node apps/cli/dist/index.js   # 或 vk，若有 bin link
```

Expected: spec §7 验收路径全过 —— Home → 提交消息 → 流式 markdown → 权限弹窗 y/a/n → ctrl+p 执行命令 → tab 切模式 → ctrl+c 退出、终端恢复正常。

- [ ] **Step 4: Commit**

```bash
git add -A apps/cli && git commit -m "feat(cli): TUI 前端改由 Bun 拉起（resolveBun + 友好报错）"
```

---

### Task 13：依赖清理 + 文档更新

**Files:**
- Modify: `pnpm-workspace.yaml`（catalog 删 ink/ink-text-input；确认无其他包引用后）
- Modify: `docs/tui-flow.md`（Ink 字样与流程描述更新）
- Modify: `README.md` / `PLAN-REMAINING.md` 中 Ink 相关描述（grep 确认）

- [ ] **Step 1: 全仓 grep 残留**

Run: `grep -rn "ink" --include="*.ts*" --include="*.json" --include="*.yaml" apps packages pnpm-workspace.yaml | grep -iv link | grep -i ink`
Expected: 无 ink 依赖残留（文档另行处理）。catalog 删除 `ink`/`ink-text-input`；frontend 的 `chalk` 若已无引用一并删除。`pnpm install` 刷新 lockfile。

- [ ] **Step 2: 文档更新**

`docs/tui-flow.md`：进程 B 描述改为 "opentui + React（Bun 运行时）"；提及 Ink 的段落更新。`docs/slash-commands.md` 若引用 TUI 渲染细节同步检查。

- [ ] **Step 3: 最终验证 + 提交**

```bash
pnpm install && pnpm build && pnpm check-types && pnpm test
cd apps/frontend && bun test src
```

全绿后：

```bash
git add -A && git commit -m "chore: 清理 ink 依赖 + TUI 文档更新（迁移完成）"
```

- [ ] **Step 4: 收尾**

使用 superpowers:verification-before-completion 技能核对 spec §7 验收清单逐项有证据，然后使用 superpowers:finishing-a-development-branch 技能决定合并方式。

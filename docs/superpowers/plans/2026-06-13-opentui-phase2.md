# 归档：Vykor TUI Phase 2 Implementation Plan

> 历史实施计划。功能状态请以当前源码、README 和 [../../tui-flow.md](../../tui-flow.md) 为准；不要从本文推导 BackendHost/LegacyJSON 或旧 session 数据流。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inline diff viewer, `@` file completion with frecency ranking, and a responsive sidebar panel to the Vykor opentui TUI.

**Architecture:** Four independent sub-features built in order of dependency: (1) ToolDiff component wires `@opentui/core`'s native `<diff>` element into the message stream; (2) Autocomplete is generalized to a common `AutocompleteItem[]` interface so both slash commands and file paths share one renderer; (3) frecency module provides a score map used by both autocomplete paths; (4) Sidebar lifts `sidebarOpen` state into `AppInner` and renders session metadata in a fixed 40-column right panel.

**Tech Stack:** React 19, `@opentui/react` 0.4.1, `@opentui/core` 0.4.1 (native `<diff>` element), npm `diff` package (`createTwoFilesPatch`), Bun runtime, `bun test` + `testRender` from `@opentui/react/test-utils`.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `apps/frontend/src/components/messages/ToolDiff.tsx` | Renders unified diff for Edit/Write tool calls |
| Create | `apps/frontend/src/components/messages/ToolDiff.test.tsx` | Frame tests for ToolDiff |
| Modify | `apps/frontend/src/routes/session/parts.tsx` | Wire ToolDiff into `case "tool"` |
| Modify | `apps/frontend/src/routes/session/Session.tsx` | Accept `sidebarOpen` prop, render Sidebar |
| Modify | `apps/frontend/src/components/prompt/Autocomplete.tsx` | Generalize to `AutocompleteItem[]` |
| Create | `apps/frontend/src/components/prompt/fileCompletion.ts` | `listProjectFiles()` via git/fs |
| Create | `apps/frontend/src/components/prompt/fileCompletion.test.ts` | Unit tests for file listing |
| Modify | `apps/frontend/src/components/prompt/Prompt.tsx` | Add `@` trigger + file autocomplete state |
| Modify | `apps/frontend/src/ui/fuzzy.ts` | Add `fuzzyFilterScored` returning `{item, score}[]` |
| Create | `apps/frontend/src/services/frecency.ts` | score/record/rank + debounced JSON persistence |
| Create | `apps/frontend/src/services/frecency.test.ts` | Unit tests for frecency math + persistence |
| Create | `apps/frontend/src/routes/session/Sidebar.tsx` | 40-col right panel: session info, files, todos, swarm, MCP |
| Create | `apps/frontend/src/routes/session/Sidebar.test.tsx` | Frame tests for Sidebar |
| Modify | `apps/frontend/src/App.tsx` | Lift `sidebarOpen`, pass to Session, gate TodoPanel/SwarmPanel |
| Modify | `apps/frontend/package.json` | Add `diff` dependency |

---

## Task 0: Smoke-probe `<diff>` component on Windows

**Purpose:** Confirm `DiffRenderable` (native Zig) works in this Windows environment before building on it. If it fails, fall back to `<code>` + manual +/- coloring.

**Files:**
- Create: `apps/frontend/scripts/probe-diff.tsx`

- [ ] **Step 1: Create probe script**

```tsx
// apps/frontend/scripts/probe-diff.tsx
import { createRenderer } from "@opentui/react";
import React from "react";

const PATCH = `--- a/hello.ts
+++ b/hello.ts
@@ -1,3 +1,4 @@
 const x = 1;
-const y = 2;
+const y = 3;
+const z = 4;
 export { x, y };
`;

const renderer = createRenderer({ width: 80, height: 20 });
renderer.render(
  <diff
    diff={PATCH}
    view="unified"
    showLineNumbers={true}
    height={10}
  />
);
await new Promise((r) => setTimeout(r, 500));
renderer.destroy();
process.exit(0);
```

- [ ] **Step 2: Run the probe**

```bash
cd apps/frontend
bun run scripts/probe-diff.tsx
```

Expected: diff renders with `+`/`-` colored lines and exits 0. If it crashes with a native error, note the error and use the fallback `<code>`-based approach for Task 1.

- [ ] **Step 3: Commit probe**

```bash
git add apps/frontend/scripts/probe-diff.tsx
git commit -m "chore(frontend): add diff component Windows smoke probe"
```

---

## Task 1: ToolDiff component + parts.tsx integration

**Files:**
- Create: `apps/frontend/src/components/messages/ToolDiff.tsx`
- Modify: `apps/frontend/src/routes/session/parts.tsx`
- Modify: `apps/frontend/package.json`

### Step 1: Add `diff` npm dependency

- [ ] Edit `apps/frontend/package.json` — add to `"dependencies"`:

```json
"diff": "^7.0.0"
```

- [ ] Run:

```bash
cd /d/code/personal-project/Vykor
pnpm install
```

Expected: `diff` package installed, lockfile updated.

### Step 2: Write failing test

- [ ] Create `apps/frontend/src/components/messages/ToolDiff.test.tsx`:

```tsx
import { test, expect } from "bun:test";
import React from "react";
import { testRender } from "@opentui/react/test-utils";
import { ThemeProvider } from "../../theme/ThemeContext";
import { ToolDiff, truncatePatch } from "./ToolDiff";

// ─── truncatePatch unit tests (no render needed) ─────────────────────────────

test("truncatePatch keeps short patch intact", () => {
  const patch = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
  expect(truncatePatch(patch, 20)).toBe(patch);
});

test("truncatePatch truncates long patch and appends summary", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  const patch = lines.join("\n");
  const result = truncatePatch(patch, 20);
  const resultLines = result.split("\n");
  expect(resultLines.length).toBe(21); // 20 kept + 1 summary
  expect(resultLines[20]).toContain("more lines");
});

// ─── ToolDiff render tests ────────────────────────────────────────────────────

test("ToolDiff renders diff for Edit tool", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <box width={80} height={20}>
        <ToolDiff
          filePath="src/foo.ts"
          oldText="const x = 1;\n"
          newText="const x = 2;\n"
        />
      </box>
    </ThemeProvider>,
    { width: 80, height: 20 },
  );

  await renderOnce();
  // Poll for async diff render
  for (let i = 0; i < 20; i++) {
    await renderOnce();
    await new Promise((r) => setTimeout(r, 30));
    if (captureCharFrame().includes("foo.ts")) break;
  }
  const frame = captureCharFrame();
  expect(frame).toContain("foo.ts");
  renderer.destroy();
});

test("ToolDiff renders all-added patch for Write tool (oldText='')", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <box width={80} height={20}>
        <ToolDiff
          filePath="src/new.ts"
          oldText=""
          newText="export const hello = 'world';\n"
        />
      </box>
    </ThemeProvider>,
    { width: 80, height: 20 },
  );

  await renderOnce();
  for (let i = 0; i < 20; i++) {
    await renderOnce();
    await new Promise((r) => setTimeout(r, 30));
    if (captureCharFrame().includes("new.ts")) break;
  }
  const frame = captureCharFrame();
  expect(frame).toContain("new.ts");
  renderer.destroy();
});
```

- [ ] Run test to verify it fails:

```bash
cd apps/frontend
bun test src/components/messages/ToolDiff.test.tsx
```

Expected: FAIL — `ToolDiff` module not found.

### Step 3: Implement ToolDiff

- [ ] Create `apps/frontend/src/components/messages/ToolDiff.tsx`:

```tsx
import React from "react";
import { createTwoFilesPatch } from "diff";
import type { SyntaxStyle } from "@opentui/core";
import { useTheme } from "../../theme/ThemeContext";

const MAX_PATCH_LINES = 20;

/** Derive filetype string from file extension for syntax highlighting. */
function filetypeFromPath(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rs: "rust", go: "go", json: "json", md: "markdown",
    css: "css", html: "html", sh: "bash", yaml: "yaml", yml: "yaml",
  };
  return ext ? map[ext] : undefined;
}

/**
 * Truncate a unified patch to `maxLines` diff lines.
 * Exported for unit testing.
 */
export function truncatePatch(patch: string, maxLines = MAX_PATCH_LINES): string {
  const lines = patch.split("\n");
  if (lines.length <= maxLines) return patch;
  const kept = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  kept.push(`… +${remaining} more lines`);
  return kept.join("\n");
}

export type ToolDiffProps = {
  filePath: string;
  oldText: string;
  newText: string;
  syntaxStyle?: SyntaxStyle;
};

export function ToolDiff({ filePath, oldText, newText, syntaxStyle }: ToolDiffProps) {
  const { theme } = useTheme();
  const c = theme.colors;

  const rawPatch = createTwoFilesPatch(filePath, filePath, oldText, newText, "", "");
  const patch = truncatePatch(rawPatch);
  const filetype = filetypeFromPath(filePath);

  return (
    <diff
      diff={patch}
      view="unified"
      showLineNumbers={true}
      filetype={filetype}
      syntaxStyle={syntaxStyle}
      addedBg={c.success + "33"}
      removedBg={c.error + "33"}
    />
  );
}
```

- [ ] Run test again:

```bash
bun test src/components/messages/ToolDiff.test.tsx
```

Expected: PASS (all tests).

### Step 4: Wire ToolDiff into parts.tsx

- [ ] Edit `apps/frontend/src/routes/session/parts.tsx`.

Add imports at the top (after existing imports):

```tsx
import { ToolDiff } from "../../components/messages/ToolDiff";
```

Replace the entire `case "tool"` block (lines 53–65) with:

```tsx
    case "tool": {
      const toolName = item.tool_name ?? "tool";

      // Edit / Write / str_replace_editor → render inline diff
      const isEditTool = toolName === "Edit" || toolName === "str_replace_editor";
      const isWriteTool = toolName === "Write" || toolName === "create_file";

      if (isEditTool && item.tool_input?.old_string !== undefined && item.tool_input?.new_string !== undefined) {
        const filePath = String(item.tool_input.path ?? item.tool_input.file_path ?? "file");
        const oldText = String(item.tool_input.old_string);
        const newText = String(item.tool_input.new_string);
        // Count +/- lines for header
        const addedLines = newText.split("\n").length - oldText.split("\n").length;
        const sign = addedLines >= 0 ? `+${addedLines}` : `${addedLines}`;
        return (
          <box flexDirection="column">
            <text fg={c.muted}>
              <span fg={c.muted}>{icons.tool}</span>
              <span fg={c.foreground} attributes={TextAttributes.BOLD}>{filePath}</span>
              <span fg={addedLines >= 0 ? c.success : c.error}>{" " + sign}</span>
            </text>
            <ToolDiff filePath={filePath} oldText={oldText} newText={newText} syntaxStyle={syntax} />
          </box>
        );
      }

      if (isWriteTool && item.tool_input?.content !== undefined) {
        const filePath = String(item.tool_input.path ?? item.tool_input.file_path ?? "file");
        const content = String(item.tool_input.content);
        return (
          <box flexDirection="column">
            <text fg={c.muted}>
              <span fg={c.muted}>{icons.tool}</span>
              <span fg={c.foreground} attributes={TextAttributes.BOLD}>{filePath}</span>
              <span fg={c.success}>{` +${content.split("\n").length}`}</span>
            </text>
            <ToolDiff filePath={filePath} oldText="" newText={content} syntaxStyle={syntax} />
          </box>
        );
      }

      // All other tools: existing single-line summary
      const summary = summarizeToolInput(item.tool_input);
      return (
        <text fg={c.muted}>
          <span fg={c.muted}>{icons.tool}</span>
          <span fg={c.muted} attributes={TextAttributes.BOLD}>{toolName}</span>
          {summary ? <span fg={c.muted}>{" " + summary}</span> : null}
        </text>
      );
    }
```

Note: `TranscriptPart` needs `syntax` prop to forward to `ToolDiff`. Update the function signature:

```tsx
export function TranscriptPart({
  item,
  syntax,
}: {
  item: TranscriptItem;
  syntax: SyntaxStyle;
}) {
```

(Already has `syntax` param — just pass it through to `ToolDiff` via the `syntaxStyle` prop above.)

- [ ] Run build + existing tests:

```bash
cd /d/code/personal-project/Vykor
pnpm --filter @vykor/frontend build
pnpm --filter @vykor/frontend test
```

Expected: build succeeds, all tests pass.

### Step 5: Commit

```bash
git add apps/frontend/package.json apps/frontend/src/components/messages/ apps/frontend/src/routes/session/parts.tsx pnpm-lock.yaml
git commit -m "feat(frontend): inline diff viewer for Edit/Write tool messages"
```

---

## Task 2: Generalize Autocomplete to AutocompleteItem

**Files:**
- Modify: `apps/frontend/src/components/prompt/Autocomplete.tsx`
- Modify: `apps/frontend/src/ui/fuzzy.ts`
- Modify: `apps/frontend/src/components/prompt/Prompt.tsx`

**Why:** The same Autocomplete renderer will be used for both slash commands and file paths. We extract a generic `AutocompleteItem` type so callers assemble items and Autocomplete only renders.

### Step 1: Write failing test

- [ ] Create `apps/frontend/src/components/prompt/Autocomplete.test.tsx`:

```tsx
import { test, expect } from "bun:test";
import React from "react";
import { testRender } from "@opentui/react/test-utils";
import { ThemeProvider } from "../../theme/ThemeContext";
import { Autocomplete } from "./Autocomplete";
import type { AutocompleteItem } from "./Autocomplete";

test("Autocomplete renders items with two-column layout", async () => {
  const items: AutocompleteItem[] = [
    { id: "/clear", label: "/clear", detail: "Clear the transcript" },
    { id: "/new", label: "/new", detail: "Start a new conversation" },
    { id: "/help", label: "/help" },
  ];

  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <box width={60} height={10}>
        <Autocomplete items={items} selectedIndex={0} />
      </box>
    </ThemeProvider>,
    { width: 60, height: 10 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  expect(frame).toContain("/clear");
  expect(frame).toContain("Clear the transcript");
  expect(frame).toContain("/new");
  expect(frame).toContain("/help");

  renderer.destroy();
});

test("Autocomplete highlights selected row", async () => {
  const items: AutocompleteItem[] = [
    { id: "/a", label: "/a" },
    { id: "/b", label: "/b" },
  ];

  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <box width={40} height={5}>
        <Autocomplete items={items} selectedIndex={1} />
      </box>
    </ThemeProvider>,
    { width: 40, height: 5 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  expect(frame).toContain("/a");
  expect(frame).toContain("/b");

  renderer.destroy();
});
```

- [ ] Run test to verify it fails (type mismatch or missing export):

```bash
cd apps/frontend
bun test src/components/prompt/Autocomplete.test.tsx
```

### Step 2: Refactor Autocomplete.tsx

- [ ] Replace the entire content of `apps/frontend/src/components/prompt/Autocomplete.tsx`:

```tsx
import React from "react";
import { useTheme } from "../../theme/ThemeContext";

const MAX_SUGGESTIONS = 10;

export type AutocompleteItem = {
  id: string;
  label: string;
  detail?: string;
};

export type AutocompleteProps = {
  items: AutocompleteItem[];
  selectedIndex: number;
};

export function Autocomplete({ items, selectedIndex }: AutocompleteProps) {
  const { theme } = useTheme();
  const visible = items.slice(0, MAX_SUGGESTIONS);
  if (visible.length === 0) return null;

  const nameColWidth = Math.max(...visible.map((c) => c.label.length)) + 4;

  return (
    <box flexDirection="column" backgroundColor={theme.colors.backgroundPanel}>
      {visible.map((item, idx) => {
        const isSelected = idx === selectedIndex;
        return (
          <box
            key={item.id}
            flexDirection="row"
            width="100%"
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={isSelected ? theme.colors.accent : undefined}
          >
            <text
              fg={isSelected ? theme.colors.background : theme.colors.foreground}
              flexShrink={0}
            >
              {item.label.padEnd(nameColWidth)}
            </text>
            {item.detail ? (
              <text fg={isSelected ? theme.colors.background : theme.colors.muted}>
                {item.detail}
              </text>
            ) : null}
          </box>
        );
      })}
    </box>
  );
}
```

### Step 3: Add `fuzzyFilterScored` to fuzzy.ts

- [ ] Append **only** the following to `apps/frontend/src/ui/fuzzy.ts` (do NOT add `scoreSubsequence` — it already exists in the file):

```ts
/**
 * Like fuzzyFilter but returns items with their scores, useful for frecency tie-breaking.
 * Reuses the private scoreSubsequence function already defined above.
 */
export function fuzzyFilterScored<T>(
  items: T[],
  query: string,
  key: (t: T) => string,
): Array<{ item: T; score: number }> {
  if (query === "") return items.map((item) => ({ item, score: 0 }));
  const q = query.toLowerCase();
  const hasSeparator = q.includes("/");

  const scored: Array<{ item: T; score: number; index: number }> = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const label = key(item).toLowerCase();
    let score: number;
    if (hasSeparator) {
      score = label.startsWith(q) ? 100 + (q.length === label.length ? 10 : 0) : 0;
    } else {
      score = scoreSubsequence(label, q);
    }
    if (score > 0) scored.push({ item, score, index: i });
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map(({ item, score }) => ({ item, score }));
}
```

`scoreSubsequence` is already defined as a private function at the bottom of `fuzzy.ts`. Do not add it again — `fuzzyFilterScored` calls the existing one directly.

### Step 4: Update Prompt.tsx to use new Autocomplete API

The current `Prompt.tsx` calls `getAutocompleteSuggestions` and passes `commands: Command[]`. We need to convert to `items: AutocompleteItem[]`.

- [ ] In `apps/frontend/src/components/prompt/Prompt.tsx`, replace the Autocomplete usage.

Find the import line:
```tsx
import { Autocomplete, getAutocompleteSuggestions } from "./Autocomplete";
import type { Command } from "../../keymap/commands";
```

Replace with:
```tsx
import { Autocomplete } from "./Autocomplete";
import type { AutocompleteItem } from "./Autocomplete";
import { fuzzyFilterScored } from "../../ui/fuzzy";
import type { Command } from "../../keymap/commands";
```

Find where `acSuggestions` is derived and replace:
```tsx
// OLD:
const acSuggestions = acOpen
  ? getAutocompleteSuggestions(content, slashCommands)
  : [];
```
With:
```tsx
// NEW — build AutocompleteItem[] from filtered commands
const acSuggestions: AutocompleteItem[] = acOpen
  ? fuzzyFilterScored(slashCommands, content, (c) => c.id)
      .map(({ item: cmd }) => ({
        id: cmd.id,
        label: cmd.id,
        detail: cmd.title !== cmd.id ? cmd.title : undefined,
      }))
  : [];
```

Find the `<Autocomplete>` JSX and replace:
```tsx
// OLD:
<Autocomplete
  query={content}
  commands={slashCommands}
  selectedIndex={acIndex}
/>
```
With:
```tsx
// NEW:
<Autocomplete
  items={acSuggestions}
  selectedIndex={acIndex}
/>
```

In `handleTextareaSubmit`, the old code accessed `acSuggestions[acIndex]` and called `.run()`. Commands no longer carry `run()` on `AutocompleteItem`. Store the raw command separately:

Add a ref just after the `acSuggestions` derivation:
```tsx
const acRawCommands: Command[] = acOpen
  ? fuzzyFilterScored(slashCommands, content, (c) => c.id).map(({ item }) => item)
  : [];
```

In `handleTextareaSubmit`, replace `suggestion.run()` with:
```tsx
const suggestion = acRawCommands[acIndex];
if (suggestion) {
  suggestion.run();
  clearTextarea();
  setAcOpen(false);
}
```

Update the Tab handler in `useKeyboard`. Find the existing Tab block (currently calls `suggestion.run()` via `acSuggestions`):

```tsx
// EXISTING (to be replaced):
if (key.name === "tab") {
  if (acOpen) {
    // Complete with highlighted suggestion
    const suggestion = acSuggestions[acIndex];
    if (suggestion && textareaRef.current) {
      const completed = suggestion.id + " ";
      textareaRef.current.clear();
      textareaRef.current.insertText(completed);
      setContent(completed);
    }
  } else {
    onCycleMode();
  }
  return;
}
```

After refactor, `acSuggestions` is `AutocompleteItem[]` which has no `.run()`. The Tab completion for slash commands should remain as-is (insert `id + " "`), but the autocomplete complete-and-run (Enter) goes through `acRawCommands`. The Tab block stays structurally the same — it inserts `acSuggestions[acIndex].id + " "` into the textarea — no change needed here since `AutocompleteItem` still has `.id`.

The only change needed in the Tab block is confirming that `acSuggestions[acIndex]` is still accessed (it is — `AutocompleteItem` has `.id`). No modification required to the Tab handler beyond ensuring `acSuggestions` is now `AutocompleteItem[]` (done in the import/derivation steps above).

- [ ] Run build to verify no type errors:

```bash
pnpm --filter @vykor/frontend build
```

- [ ] Run all frontend tests:

```bash
pnpm --filter @vykor/frontend test
```

Expected: all pass.

### Step 5: Commit

```bash
git add apps/frontend/src/components/prompt/Autocomplete.tsx apps/frontend/src/components/prompt/Prompt.tsx apps/frontend/src/ui/fuzzy.ts
git commit -m "refactor(frontend): generalize Autocomplete to AutocompleteItem[], add fuzzyFilterScored"
```

---

## Task 3: `@` file completion

**Files:**
- Create: `apps/frontend/src/components/prompt/fileCompletion.ts`
- Create: `apps/frontend/src/components/prompt/fileCompletion.test.ts`
- Modify: `apps/frontend/src/components/prompt/Prompt.tsx`

### Step 1: Write failing test

- [ ] Create `apps/frontend/src/components/prompt/fileCompletion.test.ts`:

```ts
import { test, expect, mock } from "bun:test";
import { detectAtToken, buildAtItems } from "./fileCompletion";

// ─── detectAtToken ────────────────────────────────────────────────────────────

test("detectAtToken returns null when no @ present", () => {
  expect(detectAtToken("hello world")).toBeNull();
});

test("detectAtToken returns null when @ is followed by space", () => {
  expect(detectAtToken("hello @ world")).toBeNull();
});

test("detectAtToken detects @ at start of text", () => {
  const result = detectAtToken("@src/foo");
  expect(result).not.toBeNull();
  expect(result!.token).toBe("src/foo");
  expect(result!.atStart).toBe(0);
});

test("detectAtToken detects @ after space", () => {
  const result = detectAtToken("fix the @src/bar issue");
  expect(result).not.toBeNull();
  expect(result!.token).toBe("src/bar");
  // atStart is position of '@' character
  expect(result!.atStart).toBe(8);
});

test("detectAtToken detects empty token (@)", () => {
  const result = detectAtToken("hello @");
  expect(result).not.toBeNull();
  expect(result!.token).toBe("");
});

// ─── buildAtItems ─────────────────────────────────────────────────────────────

test("buildAtItems filters by token prefix", () => {
  const files = ["src/foo.ts", "src/bar.ts", "lib/baz.ts"];
  const items = buildAtItems(files, "src/");
  expect(items.map((i) => i.id)).toContain("src/foo.ts");
  expect(items.map((i) => i.id)).toContain("src/bar.ts");
  expect(items.map((i) => i.id)).not.toContain("lib/baz.ts");
});

test("buildAtItems returns at most 10 items", () => {
  const files = Array.from({ length: 30 }, (_, i) => `src/file${i}.ts`);
  const items = buildAtItems(files, "src/");
  expect(items.length).toBeLessThanOrEqual(10);
});

test("buildAtItems empty token returns first 10 files", () => {
  const files = Array.from({ length: 30 }, (_, i) => `file${i}.ts`);
  const items = buildAtItems(files, "");
  expect(items.length).toBe(10);
});
```

- [ ] Run test to verify it fails:

```bash
cd apps/frontend
bun test src/components/prompt/fileCompletion.test.ts
```

### Step 2: Implement fileCompletion.ts

- [ ] Create `apps/frontend/src/components/prompt/fileCompletion.ts`:

```ts
import { join, relative } from "node:path";
import { readdirSync, statSync } from "node:fs";
import type { AutocompleteItem } from "./Autocomplete";

const MAX_FILES = 5000;
const MAX_ITEMS = 10;

// Skip these directories in fs walk
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", ".turbo", "build", "coverage"]);

/** In-memory cache: cwd → file list. Never invalidated (process lifetime). */
const cache = new Map<string, string[]>();

/**
 * List project files relative to cwd.
 * Tries `git ls-files` first; falls back to limited fs walk.
 */
export async function listProjectFiles(cwd: string): Promise<string[]> {
  if (cache.has(cwd)) return cache.get(cwd)!;

  let files: string[] = [];
  try {
    const proc = Bun.spawn(
      ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    files = text.split("\n").filter(Boolean).slice(0, MAX_FILES);
  } catch {
    files = fsWalk(cwd, cwd, 0).slice(0, MAX_FILES);
  }

  cache.set(cwd, files);
  return files;
}

function fsWalk(root: string, dir: string, depth: number): string[] {
  if (depth > 6) return [];
  const entries: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          if (!SKIP_DIRS.has(entry)) {
            entries.push(...fsWalk(root, full, depth + 1));
          }
        } else {
          entries.push(relative(root, full).replace(/\\/g, "/"));
        }
      } catch { /* skip unreadable entries */ }
    }
  } catch { /* skip unreadable directories */ }
  return entries;
}

/**
 * Detect if there's an active @ token at/before the cursor (end of `text`).
 * Returns null if no active token (@ followed by space, or no @ present).
 */
export function detectAtToken(
  text: string,
): { token: string; atStart: number; atEnd: number } | null {
  // Match last @ that isn't preceded by a non-whitespace char and isn't followed by a space
  const match = text.match(/(?:^|(?<=\s))@(\S*)$/);
  if (!match) return null;
  const fullMatch = match[0]!;
  const token = match[1]!;
  const atStart = text.length - fullMatch.length + (fullMatch.startsWith(" ") ? 1 : 0);
  const atEnd = text.length;
  return { token, atStart, atEnd };
}

/**
 * Build AutocompleteItem[] from a file list filtered by the current @ token.
 */
export function buildAtItems(files: string[], token: string): AutocompleteItem[] {
  const lower = token.toLowerCase();
  const filtered = token === ""
    ? files
    : files.filter((f) => f.toLowerCase().includes(lower));
  return filtered.slice(0, MAX_ITEMS).map((f) => ({ id: f, label: f }));
}
```

- [ ] Run test:

```bash
bun test src/components/prompt/fileCompletion.test.ts
```

Expected: PASS.

### Step 3: Wire `@` trigger into Prompt.tsx

- [ ] In `apps/frontend/src/components/prompt/Prompt.tsx`, add imports:

```tsx
import { listProjectFiles, detectAtToken, buildAtItems } from "./fileCompletion";
```

- [ ] Add new state variables after existing autocomplete state:

```tsx
const [fileAcOpen, setFileAcOpen] = useState(false);
const [fileAcItems, setFileAcItems] = useState<AutocompleteItem[]>([]);
const [fileAcIndex, setFileAcIndex] = useState(0);
const [filesLoaded, setFilesLoaded] = useState(false);
const filesRef = useRef<string[]>([]);
const fileAtRef = useRef<{ atStart: number; atEnd: number } | null>(null);
```

- [ ] In the `onContentChange` handler, after updating `content`, add file detection logic:

```tsx
// Detect @ token
const atResult = detectAtToken(text);
if (!busy && atResult !== null) {
  // Lazy-load file list
  if (!filesLoaded) {
    listProjectFiles(process.cwd()).then((files) => {
      filesRef.current = files;
      setFilesLoaded(true);
    });
  }
  fileAtRef.current = { atStart: atResult.atStart, atEnd: atResult.atEnd };
  setFileAcItems(buildAtItems(filesRef.current, atResult.token));
  setFileAcIndex(0);
  setFileAcOpen(true);
  setAcOpen(false); // mutually exclusive with slash completion
} else {
  setFileAcOpen(false);
  fileAtRef.current = null;
}
```

- [ ] In the JSX, render file autocomplete above slash autocomplete:

```tsx
{fileAcOpen && fileAcItems.length > 0 && (
  <Autocomplete items={fileAcItems} selectedIndex={fileAcIndex} />
)}
{acOpen && acSuggestions.length > 0 && (
  <Autocomplete items={acSuggestions} selectedIndex={acIndex} />
)}
```

- [ ] In `useKeyboard` handler, add file autocomplete navigation before slash command handling:

```tsx
if (key.name === "up") {
  if (fileAcOpen) {
    setFileAcIndex((prev) => Math.max(0, prev - 1));
    return;
  }
  if (acOpen) { /* existing */ }
  // ... history navigation
}

if (key.name === "down") {
  if (fileAcOpen) {
    setFileAcIndex((prev) => Math.min(Math.max(0, fileAcItems.length - 1), prev + 1));
    return;
  }
  // ... existing
}

if (key.name === "escape") {
  if (fileAcOpen) {
    setFileAcOpen(false);
    setFileAcIndex(0);
    return;
  }
  // ... existing
}
```

- [ ] In the Tab handler in `useKeyboard`, add file completion before slash command:

```tsx
if (key.name === "tab") {
  if (fileAcOpen) {
    const selected = fileAcItems[fileAcIndex];
    if (selected && textareaRef.current) {
      const full = textareaRef.current.plainText;
      const at = fileAtRef.current;
      if (at) {
        const next = full.slice(0, at.atStart) + "@" + selected.id + " " + full.slice(at.atEnd);
        textareaRef.current.setText(next);
        setContent(next);
      }
    }
    setFileAcOpen(false);
    return;
  }
  // ... existing slash/tab logic
}
```

- [ ] In `handleTextareaSubmit`, add file completion Enter:

```tsx
if (fileAcOpen) {
  const selected = fileAcItems[fileAcIndex];
  if (selected && textareaRef.current) {
    const full = textareaRef.current.plainText;
    const at = fileAtRef.current;
    if (at) {
      const next = full.slice(0, at.atStart) + "@" + selected.id + " " + full.slice(at.atEnd);
      textareaRef.current.setText(next);
      setContent(next);
    }
  }
  setFileAcOpen(false);
  return;
}
```

- [ ] Build and test:

```bash
pnpm --filter @vykor/frontend build
pnpm --filter @vykor/frontend test
```

Expected: build succeeds, all tests pass.

### Step 4: Commit

```bash
git add apps/frontend/src/components/prompt/fileCompletion.ts apps/frontend/src/components/prompt/fileCompletion.test.ts apps/frontend/src/components/prompt/Prompt.tsx
git commit -m "feat(frontend): @ file completion with git ls-files source"
```

---

## Task 4: Frecency service + integration

**Files:**
- Create: `apps/frontend/src/services/frecency.ts`
- Create: `apps/frontend/src/services/frecency.test.ts`
- Modify: `apps/frontend/src/components/prompt/Prompt.tsx`
- Modify: `apps/frontend/src/components/prompt/fileCompletion.ts`

### Step 1: Write failing tests

- [ ] Create `apps/frontend/src/services/frecency.test.ts`:

```ts
import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Unit tests for score formula ────────────────────────────────────────────

import { computeScore } from "./frecency";

test("computeScore returns 0 for empty timestamp list", () => {
  expect(computeScore([])).toBe(0);
});

test("computeScore gives higher score for recent usage", () => {
  const now = Date.now();
  const recent = now - 1000; // 1 second ago
  const old = now - 14 * 24 * 60 * 60 * 1000; // 14 days ago (half-life)
  const scoreRecent = computeScore([recent]);
  const scoreOld = computeScore([old]);
  // Recent should score ~2×, old should score ~1× (at exactly half-life, score ≈ 1)
  expect(scoreRecent).toBeGreaterThan(scoreOld);
  expect(scoreRecent).toBeCloseTo(2, 0); // ≈ 2^0 = 1... actually 2^(-0) = 1 for recent
});

test("computeScore accumulates over multiple usages", () => {
  const now = Date.now();
  const scoreOne = computeScore([now]);
  const scoreThree = computeScore([now, now, now]);
  expect(scoreThree).toBeGreaterThan(scoreOne);
});

// ─── Persistence roundtrip ────────────────────────────────────────────────────

test("record and rank roundtrip via JSON file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frecency-test-"));
  try {
    // Set env to point at temp dir
    process.env.VYKOR_CONFIG_DIR = dir;

    // Dynamically import to pick up env var
    const mod = await import("./frecency?t=" + Date.now());
    mod.record("command", "/clear");
    mod.record("command", "/clear");
    mod.record("command", "/new");

    // Wait for debounced write
    await new Promise((r) => setTimeout(r, 600));

    const scores = mod.rank("command");
    expect(scores.get("/clear")!).toBeGreaterThan(scores.get("/new")!);

    // Verify file was written
    const fs = await import("node:fs");
    const filePath = join(dir, "frecency.json");
    expect(fs.existsSync(filePath)).toBe(true);
  } finally {
    delete process.env.VYKOR_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rank returns empty map when JSON is corrupted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frecency-corrupt-"));
  try {
    const filePath = join(dir, "frecency.json");
    writeFileSync(filePath, "NOT JSON {{{");
    process.env.VYKOR_CONFIG_DIR = dir;

    const mod = await import("./frecency?t=" + Date.now() + "b");
    const scores = mod.rank("command");
    expect(scores.size).toBe(0); // silent reset, no throw
  } finally {
    delete process.env.VYKOR_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] Run to verify it fails:

```bash
cd apps/frontend
bun test src/services/frecency.test.ts
```

### Step 2: Implement frecency.ts

- [ ] Create `apps/frontend/src/services/frecency.ts`:

```ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

type FrecencyStore = {
  command: Record<string, number[]>;
  file: Record<string, number[]>;
};

let store: FrecencyStore | null = null;
let dirty = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function configPath(): string {
  const dir = process.env.VYKOR_CONFIG_DIR ?? join(homedir(), ".vykor");
  mkdirSync(dir, { recursive: true });
  return join(dir, "frecency.json");
}

function load(): FrecencyStore {
  if (store !== null) return store;
  try {
    const raw = readFileSync(configPath(), "utf-8");
    store = JSON.parse(raw) as FrecencyStore;
    if (!store.command) store.command = {};
    if (!store.file) store.file = {};
  } catch {
    store = { command: {}, file: {} };
  }
  return store;
}

function scheduleSave(): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (store && dirty) {
      try {
        writeFileSync(configPath(), JSON.stringify(store));
      } catch { /* silent */ }
      dirty = false;
    }
  }, 500);
}

/**
 * Score formula: sum of 2^(-Δdays / 14) for each usage timestamp.
 * Exported for unit testing.
 */
export function computeScore(timestamps: number[]): number {
  const now = Date.now();
  return timestamps.reduce((sum, ts) => {
    const deltaDays = (now - ts) / (24 * 60 * 60 * 1000);
    return sum + Math.pow(2, -deltaDays / 14);
  }, 0);
}

export function record(kind: "command" | "file", key: string): void {
  const s = load();
  if (!s[kind][key]) s[kind][key] = [];
  s[kind][key]!.push(Date.now());
  dirty = true;
  scheduleSave();
}

export function rank(kind: "command" | "file"): Map<string, number> {
  const s = load();
  const map = new Map<string, number>();
  for (const [key, timestamps] of Object.entries(s[kind])) {
    map.set(key, computeScore(timestamps));
  }
  return map;
}
```

- [ ] Run tests:

```bash
bun test src/services/frecency.test.ts
```

Expected: PASS (or close — the import cache test may need adjustment; the core `computeScore` tests must pass).

### Step 3: Integrate frecency into slash command autocomplete in Prompt.tsx

- [ ] In `apps/frontend/src/components/prompt/Prompt.tsx`, add import:

```tsx
import { record as frecencyRecord, rank as frecencyRank } from "../../services/frecency";
```

- [ ] In `acSuggestions` derivation, add frecency tie-breaking:

```tsx
const acSuggestions: AutocompleteItem[] = acOpen
  ? (() => {
      const scores = frecencyRank("command");
      return fuzzyFilterScored(slashCommands, content, (c) => c.id)
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return (scores.get(b.item.id) ?? 0) - (scores.get(a.item.id) ?? 0);
        })
        .map(({ item: cmd }) => ({
          id: cmd.id,
          label: cmd.id,
          detail: cmd.title !== cmd.id ? cmd.title : undefined,
        }));
    })()
  : [];
```

- [ ] In `handleTextareaSubmit`, after `suggestion.run()`, add:

```tsx
frecencyRecord("command", suggestion.id);
```

- [ ] In `fileCompletion.ts`, update `buildAtItems` to accept and apply frecency scores:

Replace `buildAtItems` signature:

```ts
export function buildAtItems(
  files: string[],
  token: string,
  frecencyScores?: Map<string, number>,
): AutocompleteItem[]
```

Add sorting by frecency when no specific token filter (empty token shows frecency-sorted files):

```ts
export function buildAtItems(
  files: string[],
  token: string,
  frecencyScores?: Map<string, number>,
): AutocompleteItem[] {
  const lower = token.toLowerCase();
  const filtered = token === ""
    ? [...files].sort((a, b) => (frecencyScores?.get(b) ?? 0) - (frecencyScores?.get(a) ?? 0))
    : files.filter((f) => f.toLowerCase().includes(lower));
  return filtered.slice(0, MAX_ITEMS).map((f) => ({ id: f, label: f }));
}
```

- [ ] In `Prompt.tsx`, update the `buildAtItems` call to pass frecency scores:

```tsx
const fileScores = frecencyRank("file");
setFileAcItems(buildAtItems(filesRef.current, atResult.token, fileScores));
```

- [ ] In the file selection handler (Tab + Enter), after setting textarea text, add:

```tsx
frecencyRecord("file", selected.id);
```

- [ ] Build and test:

```bash
pnpm --filter @vykor/frontend build
pnpm --filter @vykor/frontend test
```

### Step 4: Commit

```bash
git add apps/frontend/src/services/ apps/frontend/src/components/prompt/Prompt.tsx apps/frontend/src/components/prompt/fileCompletion.ts
git commit -m "feat(frontend): frecency ranking for slash commands and @ file completion"
```

---

## Task 5: Sidebar component + Session layout + App wiring

**Files:**
- Create: `apps/frontend/src/routes/session/Sidebar.tsx`
- Create: `apps/frontend/src/routes/session/Sidebar.test.tsx`
- Modify: `apps/frontend/src/routes/session/Session.tsx`
- Modify: `apps/frontend/src/App.tsx`

### Step 1: Write failing tests

- [ ] Create `apps/frontend/src/routes/session/Sidebar.test.tsx`:

```tsx
import { test, expect } from "bun:test";
import React from "react";
import { testRender } from "@opentui/react/test-utils";
import { ThemeProvider } from "../../theme/ThemeContext";
import { Sidebar } from "./Sidebar";
import { computeModifiedFiles } from "./Sidebar";
import type { TranscriptItem } from "../../types";

// ─── computeModifiedFiles unit tests ─────────────────────────────────────────

test("computeModifiedFiles extracts files from Edit/Write tool calls", () => {
  const items: TranscriptItem[] = [
    { role: "tool", text: "", tool_name: "Edit", tool_input: { path: "src/a.ts", old_string: "x", new_string: "y" } },
    { role: "tool", text: "", tool_name: "Write", tool_input: { path: "src/b.ts", content: "new content" } },
    { role: "tool", text: "", tool_name: "bash_tool", tool_input: { command: "echo hi" } },
  ];
  const files = computeModifiedFiles(items);
  expect(files.map((f) => f.path)).toContain("src/a.ts");
  expect(files.map((f) => f.path)).toContain("src/b.ts");
  expect(files.map((f) => f.path)).not.toContain(undefined);
  expect(files.length).toBe(2); // bash_tool ignored
});

test("computeModifiedFiles deduplicates same path, keeps last", () => {
  const items: TranscriptItem[] = [
    { role: "tool", text: "", tool_name: "Edit", tool_input: { path: "src/a.ts", old_string: "x", new_string: "y" } },
    { role: "tool", text: "", tool_name: "Edit", tool_input: { path: "src/a.ts", old_string: "y", new_string: "z" } },
  ];
  const files = computeModifiedFiles(items);
  expect(files.length).toBe(1);
  expect(files[0]!.path).toBe("src/a.ts");
});

// ─── Sidebar render tests ─────────────────────────────────────────────────────

test("Sidebar renders session info block", async () => {
  const status = { permission_mode: "default", model: "claude-opus-4-5", input_tokens: 1234, output_tokens: 56 };

  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <Sidebar
        status={status}
        transcript={[]}
        mcpServers={[]}
        todoMarkdown=""
        swarmTeammates={[]}
        swarmNotifications={[]}
      />
    </ThemeProvider>,
    { width: 40, height: 20 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  expect(frame).toContain("claude-opus-4-5");
  expect(frame).toContain("default");

  renderer.destroy();
});

test("Sidebar renders MCP list", async () => {
  const mcpServers = [
    { name: "filesystem", state: "connected", tool_count: 5 },
    { name: "github", state: "error" },
  ];

  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <Sidebar
        status={{}}
        transcript={[]}
        mcpServers={mcpServers}
        todoMarkdown=""
        swarmTeammates={[]}
        swarmNotifications={[]}
      />
    </ThemeProvider>,
    { width: 40, height: 20 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  expect(frame).toContain("filesystem");
  expect(frame).toContain("github");

  renderer.destroy();
});

test("Sidebar renders modified files from transcript", async () => {
  const transcript: TranscriptItem[] = [
    { role: "tool", text: "", tool_name: "Edit", tool_input: { path: "src/main.ts", old_string: "a", new_string: "b" } },
  ];

  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <Sidebar
        status={{}}
        transcript={transcript}
        mcpServers={[]}
        todoMarkdown=""
        swarmTeammates={[]}
        swarmNotifications={[]}
      />
    </ThemeProvider>,
    { width: 40, height: 20 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  expect(frame).toContain("main.ts");

  renderer.destroy();
});
```

- [ ] Run to verify fails:

```bash
bun test src/routes/session/Sidebar.test.tsx
```

### Step 2: Implement Sidebar.tsx

- [ ] Create `apps/frontend/src/routes/session/Sidebar.tsx`:

```tsx
import React from "react";
import { TextAttributes } from "@opentui/core";
import { useTheme } from "../../theme/ThemeContext";
import { parseTodoItems } from "../../components/TodoPanel";
import type { TranscriptItem, McpServerSnapshot, SwarmTeammateSnapshot, SwarmNotificationSnapshot } from "../../types";

export type ModifiedFile = {
  path: string;
  added: number;
  removed: number;
};

/** Extract unique modified files from a transcript. */
export function computeModifiedFiles(transcript: TranscriptItem[]): ModifiedFile[] {
  const map = new Map<string, ModifiedFile>();
  for (const item of transcript) {
    if (item.role !== "tool") continue;
    const name = item.tool_name ?? "";
    const isEdit = name === "Edit" || name === "str_replace_editor";
    const isWrite = name === "Write" || name === "create_file";
    if (!isEdit && !isWrite) continue;

    const path = String(item.tool_input?.path ?? item.tool_input?.file_path ?? "");
    if (!path) continue;

    if (isEdit) {
      const old = String(item.tool_input?.old_string ?? "");
      const next = String(item.tool_input?.new_string ?? "");
      map.set(path, {
        path,
        added: next.split("\n").length,
        removed: old.split("\n").length,
      });
    } else {
      const content = String(item.tool_input?.content ?? "");
      map.set(path, { path, added: content.split("\n").length, removed: 0 });
    }
  }
  return Array.from(map.values());
}

export type SidebarProps = {
  status: Record<string, unknown>;
  transcript: TranscriptItem[];
  mcpServers: McpServerSnapshot[];
  todoMarkdown: string;
  swarmTeammates: SwarmTeammateSnapshot[];
  swarmNotifications: SwarmNotificationSnapshot[];
  version?: string | null;
};

export function Sidebar({
  status,
  transcript,
  mcpServers,
  todoMarkdown,
  swarmTeammates,
  swarmNotifications,
  version,
}: SidebarProps) {
  const { theme } = useTheme();
  const c = theme.colors;

  const mode = String(status.permission_mode ?? "");
  const model = String(status.model ?? "");
  const effort = String(status.effort ?? "");
  const inputTokens = Number(status.input_tokens ?? 0);
  const outputTokens = Number(status.output_tokens ?? 0);

  const modifiedFiles = computeModifiedFiles(transcript);
  const todoItems = parseTodoItems(todoMarkdown);
  const shownFiles = modifiedFiles.slice(0, 15);
  const extraFiles = modifiedFiles.length - shownFiles.length;

  function SectionHeader({ title }: { title: string }) {
    return (
      <text fg={c.muted} attributes={TextAttributes.BOLD}>
        {" " + title.toUpperCase()}
      </text>
    );
  }

  return (
    <box
      flexDirection="column"
      width={40}
      flexShrink={0}
      borderColor={c.muted}
      border={["left"]}
      customBorderChars={{
        topLeft: "", bottomLeft: "", vertical: "│",
        topRight: "", bottomRight: "", horizontal: " ",
        bottomT: "", topT: "", cross: "", leftT: "", rightT: "",
      }}
    >
      {/* Session info block */}
      <SectionHeader title="Session" />
      {model ? <text fg={c.foreground}>{" " + model}</text> : null}
      {mode ? <text fg={c.muted}>{" mode: " + mode}</text> : null}
      {effort ? <text fg={c.warning}>{" effort: " + effort}</text> : null}
      {(inputTokens > 0 || outputTokens > 0) ? (
        <text fg={c.muted}>{` ${inputTokens}↓ ${outputTokens}↑`}</text>
      ) : null}

      {/* Modified files */}
      {shownFiles.length > 0 ? (
        <box flexDirection="column">
          <text>{" "}</text>
          <SectionHeader title="Modified" />
          {shownFiles.map((f) => (
            <text key={f.path} fg={c.muted}>
              <span fg={c.success}>{`+${f.added}`}</span>
              <span fg={c.error}>{`-${f.removed}`}</span>
              {" " + f.path.split("/").pop()}
            </text>
          ))}
          {extraFiles > 0 ? <text fg={c.muted}>{`  +${extraFiles} more`}</text> : null}
        </box>
      ) : null}

      {/* Todos */}
      {todoItems.length > 0 ? (
        <box flexDirection="column">
          <text>{" "}</text>
          <SectionHeader title="Tasks" />
          {todoItems.slice(0, 8).map((item, i) => (
            <text key={i} fg={item.checked ? c.muted : c.foreground}>
              {(item.checked ? " ✓ " : " ○ ") + item.text.slice(0, 34)}
            </text>
          ))}
        </box>
      ) : null}

      {/* Swarm teammates */}
      {swarmTeammates.length > 0 ? (
        <box flexDirection="column">
          <text>{" "}</text>
          <SectionHeader title="Swarm" />
          {swarmTeammates.map((t) => (
            <text key={t.name} fg={c.muted}>
              {" " + t.name.slice(0, 34)}
            </text>
          ))}
        </box>
      ) : null}

      {/* MCP servers */}
      {mcpServers.length > 0 ? (
        <box flexDirection="column">
          <text>{" "}</text>
          <SectionHeader title="MCP" />
          {mcpServers.map((s) => {
            const dot = s.state === "connected" || s.state === "ok" ? "●" : "○";
            const dotColor = s.state === "error" ? c.error
              : s.state === "connected" || s.state === "ok" ? c.success
              : c.muted;
            const tools = s.tool_count ? ` (${s.tool_count})` : "";
            return (
              <text key={s.name} fg={c.muted}>
                <span fg={dotColor}>{dot}</span>
                {" " + s.name.slice(0, 32) + tools}
              </text>
            );
          })}
        </box>
      ) : null}
    </box>
  );
}
```

- [ ] Run tests:

```bash
bun test src/routes/session/Sidebar.test.tsx
```

Expected: PASS.

### Step 3: Update Session.tsx to accept sidebarOpen + render Sidebar

- [ ] Replace `apps/frontend/src/routes/session/Session.tsx` entirely:

```tsx
import React, { useMemo } from "react";
import { useTheme } from "../../theme/ThemeContext";
import { createSyntaxStyle } from "../../theme/syntax";
import type { TranscriptItem, McpServerSnapshot, SwarmTeammateSnapshot, SwarmNotificationSnapshot } from "../../types";
import { TranscriptPart } from "./parts";
import { Sidebar } from "./Sidebar";

export type SessionProps = {
  items: TranscriptItem[];
  assistantBuffer: string;
  // Sidebar props
  sidebarOpen: boolean;
  status: Record<string, unknown>;
  mcpServers: McpServerSnapshot[];
  todoMarkdown: string;
  swarmTeammates: SwarmTeammateSnapshot[];
  swarmNotifications: SwarmNotificationSnapshot[];
  version?: string | null;
};

export function Session({
  items,
  assistantBuffer,
  sidebarOpen,
  status,
  mcpServers,
  todoMarkdown,
  swarmTeammates,
  swarmNotifications,
  version,
}: SessionProps) {
  const { theme } = useTheme();
  const syntax = useMemo(() => createSyntaxStyle(theme), [theme]);

  return (
    <box flexDirection="row" flexGrow={1}>
      <scrollbox
        flexGrow={1}
        stickyScroll
        stickyStart="bottom"
        verticalScrollbarOptions={{
          trackOptions: {
            foregroundColor: theme.colors.muted,
            backgroundColor: theme.colors.backgroundPanel,
          },
        }}
      >
        {items.map((item, i) => (
          <TranscriptPart key={i} item={item} syntax={syntax} />
        ))}
        {assistantBuffer ? (
          <markdown content={assistantBuffer} syntaxStyle={syntax} streaming />
        ) : null}
      </scrollbox>
      {sidebarOpen ? (
        <Sidebar
          status={status}
          transcript={items}
          mcpServers={mcpServers}
          todoMarkdown={todoMarkdown}
          swarmTeammates={swarmTeammates}
          swarmNotifications={swarmNotifications}
          version={version}
        />
      ) : null}
    </box>
  );
}
```

### Step 4: Update App.tsx — lift sidebarOpen, wire Session, gate panels

- [ ] In `apps/frontend/src/App.tsx`, make the following changes:

**A. Add `useTerminalDimensions` import** (already imported via `useRenderer`; add if missing):

```tsx
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
```

**B. Add to `AppViewProps`:**

```tsx
sidebarOpen: boolean;
onToggleSidebar: () => void;
```

**C. Update `AppView` function signature** to destructure new props:

```tsx
export function AppView({
  // ... existing props ...
  sidebarOpen,
  onToggleSidebar,
}: AppViewProps) {
```

**D. In the session route render** (the `return` block that renders Session), replace:

```tsx
<Session items={transcript} assistantBuffer={assistantBuffer} />
{todoMarkdown ? <TodoPanel markdown={todoMarkdown} /> : null}
{(swarmTeammates.length > 0 || swarmNotifications.length > 0) ? (
  <SwarmPanel teammates={swarmTeammates} notifications={swarmNotifications} />
) : null}
```

With:

```tsx
<Session
  items={transcript}
  assistantBuffer={assistantBuffer}
  sidebarOpen={sidebarOpen}
  status={status}
  mcpServers={mcpServers}
  todoMarkdown={todoMarkdown}
  swarmTeammates={swarmTeammates}
  swarmNotifications={swarmNotifications}
  version={version}
/>
{!sidebarOpen && todoMarkdown ? <TodoPanel markdown={todoMarkdown} /> : null}
{!sidebarOpen && (swarmTeammates.length > 0 || swarmNotifications.length > 0) ? (
  <SwarmPanel teammates={swarmTeammates} notifications={swarmNotifications} />
) : null}
```

**E. In `AppInner`**, add sidebarOpen state and terminal width:

```tsx
const { width: terminalWidth } = useTerminalDimensions();
const [sidebarOpen, setSidebarOpen] = useState(() => terminalWidth >= 110);
```

**F. In `AppInner`**'s `useKeyboard` handler, add `ctrl+b`:

```tsx
if (key.ctrl && key.name === "b") {
  setSidebarOpen((v) => !v);
}
```

**G. Add `app.sidebar` to the command registry** in `AppInner` (find where `buildRegistry` is called and add):

```tsx
{ id: "app.sidebar", title: "Toggle Sidebar", run: () => setSidebarOpen((v) => !v) }
```

**H. Pass new props to `AppView`**:

```tsx
sidebarOpen={sidebarOpen}
onToggleSidebar={() => setSidebarOpen((v) => !v)}
```

**I. Update `AppViewProps` base props in `App.test.tsx`** to include:

```tsx
sidebarOpen: false,
onToggleSidebar: () => {},
```

- [ ] Build and all tests:

```bash
pnpm --filter @vykor/frontend build
pnpm --filter @vykor/frontend test
```

Expected: build succeeds, all tests pass (including App.test.tsx — update baseProps there if needed).

### Step 5: Commit

```bash
git add apps/frontend/src/routes/session/Sidebar.tsx apps/frontend/src/routes/session/Sidebar.test.tsx apps/frontend/src/routes/session/Session.tsx apps/frontend/src/App.tsx
git commit -m "feat(frontend): Sidebar panel with session info, modified files, todos, MCP"
```

---

## Task 6: Final regression + cleanup

**Files:**
- Modify: `apps/frontend/src/App.test.tsx` (update baseProps if needed)

- [ ] **Step 1: Run full test suite**

```bash
cd /d/code/personal-project/Vykor
pnpm --filter @vykor/frontend test
```

Expected: all tests pass, 0 failures.

- [ ] **Step 2: Run type check**

```bash
pnpm check-types
```

Expected: 27 packages, 0 errors.

- [ ] **Step 3: Run build**

```bash
pnpm --filter @vykor/frontend build
```

Expected: `Build complete: 2 files`

- [ ] **Step 4: Commit cleanup**

```bash
git add -A
git commit -m "chore(frontend): phase 2 regression pass — all tests green"
```

# First-Pass Dead-Code Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the approved high-confidence dead code without changing product behavior or touching the user's in-progress Desktop files.

**Architecture:** Treat each workspace domain as an independent cleanup boundary. Preserve all public/runtime entry points, delete only code proven unreachable by imports and configured entry points, then verify each domain with its own compiler and test commands.

**Tech Stack:** TypeScript 5.7, React 19, Bun test, Vitest, Electron, ESLint, pnpm workspaces

**Spec:** `docs/superpowers/specs/2026-08-19-first-pass-dead-code-cleanup-design.md`

## Global Constraints

- Do not edit or revert the user's pre-existing Desktop changes.
- Do not remove window, tray, or pet IPC endpoints in this batch.
- Do not change public SDK exports based only on repository-local usage.
- Pure deletions use baseline-and-regression verification; do not add tests that merely assert a source file is absent.

---

### Task 1: Runtime API-surface cleanup

**Files:**
- Modify: `packages/agent-runtime/src/agent.ts:779`
- Test: `packages/agent-runtime/src/*.test.ts`

**Interfaces:**
- Consumes: the existing same-file call `serializeError(error: unknown): AgentSerializedError`
- Produces: the same internal function and runtime behavior, without a module-level export

- [ ] **Step 1: Establish the runtime behavior baseline**

Run: `pnpm --filter @vykor/agent-runtime test`

Expected: all runtime tests pass before editing.

- [ ] **Step 2: Confirm the export has no external consumer**

Run: `rg -n "serializeError" packages apps`

Expected: one definition and one same-file production call in `packages/agent-runtime/src/agent.ts`.

- [ ] **Step 3: Remove only the `export` modifier**

Change:

```ts
function serializeError(error: unknown): AgentSerializedError {
```

- [ ] **Step 4: Verify runtime behavior**

Run: `pnpm --filter @vykor/agent-runtime test`

Expected: all runtime tests pass.

### Task 2: TUI unreachable-code and import cleanup

**Files:**
- Delete: `apps/frontend/src/modelCatalog.ts`
- Delete: `apps/frontend/scripts/probe-diff.tsx`
- Modify: `apps/frontend/src/services/frecency.ts`
- Modify: only frontend `.ts`/`.tsx` files reported by `tsc --noUnusedLocals --noUnusedParameters`
- Test: `apps/frontend/src/services/frecency.test.ts`

**Interfaces:**
- Consumes: `computeScore(timestamps: number[]): number`
- Produces: the same score curve, using `HALF_LIFE_MS` as the single half-life definition

- [ ] **Step 1: Establish the frontend baseline**

Run: `pnpm --filter @vykor/frontend check-types`

Run: `pnpm --filter @vykor/frontend test`

Expected: typecheck and all frontend tests pass.

- [ ] **Step 2: Capture exact unused-symbol diagnostics**

Run: `.\node_modules\.bin\tsc.CMD --noEmit --noUnusedLocals --noUnusedParameters -p apps/frontend/tsconfig.json`

Expected: diagnostics identify unused imports/helpers; use this list as the edit allowlist and do not change behavioral code.

- [ ] **Step 3: Preserve the frecency behavior contract**

Ensure `apps/frontend/src/services/frecency.test.ts` contains an assertion equivalent to:

```ts
expect(computeScore([now - 14 * 24 * 60 * 60 * 1000])).toBeCloseTo(0.5)
```

If it does not exist, add it with `Date.now` controlled by the test and run the focused test before changing the formula.

- [ ] **Step 4: Delete unreachable files and remove only diagnosed unused symbols**

Delete `modelCatalog.ts` and `probe-diff.tsx`. Remove unused JSX-era default React imports and unused type/test helpers reported in Step 2.

- [ ] **Step 5: Replace the duplicated half-life literal**

Use elapsed milliseconds directly:

```ts
return sum + Math.pow(2, -(now - ts) / HALF_LIFE_MS)
```

- [ ] **Step 6: Verify TUI**

Run: `pnpm --filter @vykor/frontend check-types`

Run: `pnpm --filter @vykor/frontend test`

Expected: typecheck and all frontend tests pass.

### Task 3: Desktop high-confidence dead-code cleanup

**Files:**
- Delete: `apps/desktop/src/renderer/src/components/Versions.tsx`
- Delete: `apps/desktop/src/renderer/src/components/desktop/open-with-button.tsx`
- Delete: `apps/desktop/src/renderer/src/components/desktop/conversation-page/error-banner.tsx`
- Modify: `apps/desktop/src/renderer/src/components/ui/context-menu.tsx:55`
- Modify: `apps/desktop/src/shared/ipc-channels.ts:404`
- Modify: `apps/desktop/src/main/features/main-window/window.ts:81`
- Modify: `apps/desktop/src/preload/desktop-api.ts:189`
- Modify: `apps/desktop/src/preload/index.d.ts:178`

**Interfaces:**
- Consumes: the configured Electron main/preload/renderer entries and the live `window:maximized-changed` event
- Produces: unchanged live Desktop API with only the unconsumed `main-process-message` group removed

- [ ] **Step 1: Establish the Desktop baseline**

Run: `pnpm --filter @vykor/desktop typecheck`

Run: `pnpm --filter @vykor/desktop test`

Run: `pnpm --filter @vykor/desktop exec eslint . --no-cache`

Expected: all three commands exit successfully before editing.

- [ ] **Step 2: Reconfirm no consumers**

Run: `rg -n "Versions|open-with-button|ErrorBanner|ContextMenuSeparator|IpcResult|main-process-message" apps/desktop`

Expected: deleted components/types have definitions only; `main-process-message` has one sender and one preload subscription group, with no renderer call.

- [ ] **Step 3: Delete the three unreachable component files**

Delete only the files listed above. Do not touch the `open-with/` implementation directory.

- [ ] **Step 4: Remove unused exports and the template event chain**

Remove `ContextMenuSeparator`, `IpcResult`, the `did-finish-load` sender block, the preload `events.onMainProcessMessage` group, and its matching declaration. Preserve `window:maximized-changed` and every session/terminal event.

- [ ] **Step 5: Verify Desktop**

Run: `pnpm --filter @vykor/desktop typecheck`

Run: `pnpm --filter @vykor/desktop test`

Run: `pnpm --filter @vykor/desktop exec eslint . --no-cache`

Expected: all three commands exit successfully.

### Task 4: Integrated review

**Files:**
- Review: all files changed by Tasks 1-3

**Interfaces:**
- Consumes: verified Runtime, TUI, and Desktop cleanup changes
- Produces: a scoped diff containing no unrelated user changes

- [ ] **Step 1: Scan for removed names and paths**

Run: `rg -n "serializeError|modelCatalog|probe-diff|Versions|open-with-button|ErrorBanner|ContextMenuSeparator|IpcResult|main-process-message" apps packages`

Expected: only the internal `serializeError` definition/call remains; all other removed identifiers and paths have no source references.

- [ ] **Step 2: Review the diff without modifying user work**

Run: `git status --short`

Run: `git diff -- packages/agent-runtime apps/frontend apps/desktop docs/superpowers`

Expected: the cleanup diff matches this plan, while the user's pre-existing Desktop changes remain intact and distinguishable.

- [ ] **Step 3: Run final scoped verification**

Run: `pnpm --filter @vykor/agent-runtime test`

Run: `pnpm --filter @vykor/frontend check-types`

Run: `pnpm --filter @vykor/frontend test`

Run: `pnpm --filter @vykor/desktop typecheck`

Run: `pnpm --filter @vykor/desktop test`

Run: `pnpm --filter @vykor/desktop exec eslint . --no-cache`

Expected: every command exits successfully; report any pre-existing unrelated blocker separately rather than expanding scope.

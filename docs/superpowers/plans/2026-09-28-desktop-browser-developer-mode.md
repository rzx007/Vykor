# Desktop Browser Developer Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default-off Desktop Developer mode that permits separately approved DOM, style, console, and network inspection of the active Browser tab.

**Architecture:** Keep the existing `Browser` tool and its action path intact. Add a small `BrowserDeveloper` tool on the Server side; Desktop owns the setting, current-tab checks, CDP connection, bounded output, and cleanup. The existing permission broker records each developer request, but never reuses or inherits its approval.

**Tech Stack:** TypeScript, Electron `WebContents.debugger`, React, Vitest, existing Desktop IPC and preference storage.

**Spec:** `docs/superpowers/specs/2026-09-28-desktop-browser-developer-mode-design.md`

## Global Constraints

- Developer mode defaults to `false`. The main process checks the persisted value at use time; changing the switch off immediately stops active diagnostics.
- A regular `Browser` site grant does not grant CDP access. Developer approval is explicit, once only, and never inherited from a parent session.
- Agent input never names raw CDP methods, JavaScript, target IDs, file paths, or debugging ports. Raw headers, cookies, request/response bodies, and WebSocket frames never enter tool results.
- Inspect the active, bound guest only. DOM, styles, and console are limited to the main frame; network includes requests initiated by the main frame, including third-party subresources.
- `minimax-code/packages/browser-core` is reference material only. Do not add it as a dependency or copy its source.
- Preserve the existing uncommitted edits in `browser-agent-service.ts` and its test. Run focused checks before any broader gate.

## File map and interface decisions

- `apps/desktop/src/shared/settings-types.ts`, `main/features/settings/desktop-preferences-storage.ts`, `settings-service.ts`, `settings/ipc.ts`, `shared/ipc-channels.ts`, `shared/desktop-api-contract.ts`, and `preload/desktop-api.ts`: one persisted Desktop boolean and its existing IPC path. `settings-content.tsx` adds one functional switch under settings; no new settings framework.
- `packages/server/src/application/browser-tools/browser-host.ts`: add `BrowserDeveloperAction` and `BrowserDeveloperResult`, plus optional `BrowserHost.executeDeveloper`. The method is optional so CLI/standalone hosts remain valid.
- `packages/server/src/application/browser-tools/browser-developer-tool.ts`: parse five fixed actions and bridge two approvals: ordinary origin under tool name `Browser`, developer inspection under `BrowserDeveloper`. Register alongside `Browser` in `daemon-application.ts` and export only the needed types from `index.ts` and `packages/server/src/index.ts`.
- `packages/server/src/permissions/permission-broker.ts` and Desktop `PermissionCard`: force `BrowserDeveloper` decisions to `once`, retain their own session ID, and show the validated reason and scope. Other tools keep existing behavior.
- `apps/desktop/src/main/features/browser/browser-agent-service.ts`: choose and recheck the active tab, reuse its `requireOrigin` path, and own one diagnostic lease. Add `browser-developer-inspector.ts` for fixed CDP reads, event filtering, bounds, and attachment cleanup. Do not turn this into a general CDP transport layer.

### Task 1: Persist the Desktop switch

**Files:** Modify the seven settings/IPC files in the file map and `apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx`. Extend the existing `apps/desktop/src/main/features/settings/settings-service.test.ts` and `desktop-preferences.test.ts`.

**Interfaces:** Add `browserDeveloperMode: boolean` to `DesktopSettingsSnapshot` and `DesktopPreferences`; add `updateBrowserDeveloperMode({ enabled: boolean }): Promise<DesktopSettingsSnapshot>` to Desktop settings API. Task 4 adds the main-process guard; Task 5 connects immediate capture cleanup when the switch is disabled.

- [ ] **Step 1: Write failing tests** for absent, malformed, true, and false persisted values, and reject non-boolean input. Use synthetic temporary user-data paths.
- [ ] **Step 2: Run** `pnpm --filter @vykor/desktop exec vitest run src/main/features/settings/settings-service.test.ts src/main/features/settings/desktop-preferences.test.ts` and confirm the new cases fail for missing behavior.
- [ ] **Step 3: Add the setting using the existing snapshot/preference pattern.** The update should have this shape:

  ```ts
  if (typeof input.enabled !== "boolean") throw new Error("Developer mode must be a boolean.")
  const preferences = this.dependencies.patchPreferences({ browserDeveloperMode: input.enabled })
  return this.snapshotWithPreferences(preferences)
  ```

  Connect a controlled `Switch` in Desktop settings. The UI sends a boolean; it never grants a site permission.
- [ ] **Step 4: Re-run the two focused tests** and Desktop node/web typechecks. Check that ordinary Browser tests still pass.
- [ ] **Step 5: Review and commit only this task's files**, leaving the pre-existing Browser edits untouched unless they are deliberately incorporated during implementation.

### Task 2: Make developer approval visible and non-reusable

**Files:** Modify `packages/server/src/permissions/permission-broker.ts` and `apps/desktop/src/renderer/src/components/desktop/conversation-page/message/message-block.tsx`. Test in their existing `permission-broker.test.ts` and `message/__test__/permission-card.test.ts`.

**Interfaces:** The tool name is exactly `BrowserDeveloper`. `ask()` keeps its actual session ID, skips session approval lookup, and `reply()` records `decision: "once"` for this tool even when the client sends `"session"`.

- [ ] **Step 1: Write failing tests**: a parent approval does not satisfy a child request; two developer asks in one session each remain pending until separately answered; a submitted `session` reply is stored as `once`. Render an authorization card with `payload.reason` and `payload.input.action`, and verify the site/risk text appears as escaped text while unrelated cards keep their layout.
- [ ] **Step 2: Run** `pnpm --filter @vykor/server exec vitest run src/permissions/__test__/permission-broker.test.ts` and `pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/message/__test__/permission-card.test.ts`; confirm the new cases fail.
- [ ] **Step 3: Add the narrow broker special case and card branch.** Do not change generic approval semantics:

  ```ts
  const isDeveloper = input.toolName === "BrowserDeveloper"
  const permissionSessionId = isDeveloper ? input.sessionId : this.resolvePermissionSessionId(input.sessionId)
  const reusable = isDeveloper ? undefined : this.findSessionApproval(input.sessionId, input.toolName)
  // reply: decision = current.toolName === "BrowserDeveloper" ? "once" : input.decision
  ```

  `PermissionCard` shows a bounded `payload.reason` for this tool and only “允许本次”. It renders strings as React text, never HTML.
- [ ] **Step 4: Re-run the focused tests** and Server/Desktop typechecks.
- [ ] **Step 5: Review and commit this task's files.**

### Task 3: Add a separate, fixed BrowserDeveloper tool

**Files:** Modify `packages/server/src/application/browser-tools/browser-host.ts`, `index.ts`, `packages/server/src/index.ts`, and `daemon-application.ts`. Create `browser-developer-tool.ts` and `__test__/browser-developer-tool.test.ts`.

**Interfaces:**

```ts
type BrowserDeveloperAction =
  | { action: "inspect_dom"; selector?: string }
  | { action: "inspect_styles"; selector: string }
  | { action: "start_diagnostics" }
  | { action: "read_diagnostics" }
  | { action: "stop_diagnostics" }
type BrowserDeveloperResult = { action: BrowserDeveloperAction["action"]; url: string; data: unknown; truncated?: boolean }
// Optional member on BrowserHost:
executeDeveloper?(input: {
  action: BrowserDeveloperAction; sessionId: string; cwd: string
  approveOrigin: (reason: string) => Promise<boolean>
  approveDeveloper: (reason: string) => Promise<boolean>
}): Promise<BrowserDeveloperResult>
```

- [ ] **Step 1: Write failing tool tests**: absent host/method fails closed; invalid action or selector fails before host call; each approval callback uses the correct tool name; the two read/stop actions do not create new approvals; a host result larger than 48 KiB is rejected before becoming a tool response.
- [ ] **Step 2: Run** `pnpm --filter @vykor/server exec vitest run src/application/browser-tools/__test__/browser-developer-tool.test.ts` and confirm failure.
- [ ] **Step 3: Implement the fixed input schema and tool bridge.** Register the tool beside `createBrowserTool` without changing the existing `Browser` schema. Define this local helper inside `execute` and use it for both callbacks:

  ```ts
  const ask = async (toolName: "Browser" | "BrowserDeveloper", reason: string) =>
    (await context.requestPermission?.({
      toolName, reason, input: { action: action.action },
    }))?.status === "approved"
  const approvals = {
    approveOrigin: (reason: string) => ask("Browser", reason),
    approveDeveloper: (reason: string) => ask("BrowserDeveloper", reason),
  }
  ```

  Send only action and validated site/file scope in permission input; never pass page content or a raw CDP result. Before returning, serialize `BrowserDeveloperResult` and reject output above 48 KiB. Desktop also bounds each result; this Server check is the final boundary against malformed host output.
- [ ] **Step 4: Re-run the focused test** and Server typecheck. Check the existing Browser tool test remains green.
- [ ] **Step 5: Review and commit this task's files.**

### Task 4: Implement single-shot DOM and style inspection

**Files:** Modify `apps/desktop/src/main/features/browser/browser-agent-service.ts`. Create `browser-developer-inspector.ts` and `browser-developer-inspector.test.ts`; add service-level tests in `browser-developer-service.test.ts` beside the existing Browser test.

**Interfaces:** `BrowserAgentService.executeDeveloper(input)` implements Task 3's optional host method. `BrowserDeveloperInspector.inspectDom(contents, selector?)` and `.inspectStyles(contents, selector)` return bounded, filtered objects. An inspector instance belongs to one active Browser service; it receives a WebContents selected by the service, not a target ID from the tool.

- [ ] **Step 1: Write failing tests** using a fake guest/debugger: switch off rejects before attach; manually opened page requests ordinary approval first via the existing session/origin cache; refusal prevents CDP request; approval prompt includes validated origin or actual workspace file; symlink escaping the workspace fails; tab/navigation changes while either approval waits or a command runs suppress output. Test DOM field redaction, CSS selector validation, and result truncation.
- [ ] **Step 2: Run** `pnpm --filter @vykor/desktop exec vitest run src/main/features/browser/browser-developer-inspector.test.ts src/main/features/browser/browser-developer-service.test.ts` and confirm failure.
- [ ] **Step 3: Implement a fixed CDP read path.** Route `executeDeveloper` through the existing short operation queue to fix the selected tab during approval and reading; revocation remains immediate and invalidates any pending result. Until Task 5, return a controlled “not available yet” error for diagnostic actions. Use `DOM.getDocument` with bounded depth and `pierce: false`; resolve a CSS selector with `DOM.querySelector`/`DOM.describeNode`; for styles use `CSS.getComputedStyleForNode`. Filter secret-looking attributes and sensitive input values before returning. Never accept or forward an arbitrary CDP method or node ID. Refuse a guest whose debugger is already attached by another owner. The command path should remain explicit:

  ```ts
  const { root } = await debuggerClient.sendCommand("DOM.getDocument", { depth: 2, pierce: false })
  const { nodeId } = await debuggerClient.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector })
  const { node } = await debuggerClient.sendCommand("DOM.describeNode", { nodeId, depth: 2 })
  // For inspect_styles only: CSS.enable, then CSS.getComputedStyleForNode({ nodeId }).
  ```
- [ ] **Step 4: Re-run the focused tests**, existing `browser-agent-service.test.ts`, and Desktop node typecheck. Preserve its pre-existing edits.
- [ ] **Step 5: Review and commit this task's files, including only intentional changes to the existing Browser service.**

### Task 5: Add bounded console/network capture and lifecycle cleanup

**Files:** Extend `browser-developer-inspector.ts`, `browser-agent-service.ts`, `browser-developer-inspector.test.ts`, and `browser-developer-service.test.ts`. Modify `apps/desktop/src/main/features/settings/settings-service.ts` and `apps/desktop/src/main/features/session/session-service.ts` to stop the lease on disable and session deletion; cover these hooks in their focused tests.

**Interfaces:** The inspector owns at most one `{ sessionId, tabId, webContentsId, mainFrameId, approvedScope, navigationEpoch, approvedAt, expiresAt, paused }` lease. Expose `startDiagnostics`, `readDiagnostics`, and `stopDiagnostics`; set concrete limits of 60 seconds, 200 events per stream, and 48 KiB per returned page. The Browser service increments the navigation epoch on every main-frame document navigation and exposes `stopDeveloperDiagnostics(): void`. Since only one lease exists, any Desktop session deletion stops it before the asynchronous delete call; this also covers deleted child sessions without an ancestry lookup.

- [ ] **Step 1: Write failing tests**: event listeners start only after developer approval; console messages are limited to the main-frame default context; network entries require the main frame's `frameId` and retain only method, sanitized URL, type, status, failure, and duration; no headers/body/cookies enter the buffer. Same-origin reload pauses capture, clears the old epoch and pending request IDs, then resumes only after the new main document/context is identified; a delayed old response is discarded. Cross-origin navigation stops at navigation start. Tab switch/disable/delete/destroy/timeout detach and clear. Disabling via Desktop settings calls `stopDeveloperDiagnostics` immediately. A second session cannot take over the lease.
- [ ] **Step 2: Run** `pnpm --filter @vykor/desktop exec vitest run src/main/features/browser/browser-developer-inspector.test.ts src/main/features/browser/browser-developer-service.test.ts src/main/features/settings/settings-service.test.ts` and confirm the new cases fail.
- [ ] **Step 3: Implement one lease and cleanup path.** Use Electron debugger events only for the approved guest. Start `Page`, `Runtime`, and `Network` domains after approval. Match requests to responses by request ID; sanitize before buffering. `Runtime.enable` may surface earlier messages, so discard events whose timestamp predates approval. At navigation start set `lease.paused = true`, clear buffers and pending IDs; after the new main frame and default execution context are confirmed, resume only if its scope is still approved. Every read rechecks current setting, session, tab, origin/file path, epoch, and expiry. Settings-disable stops immediately. At the start of any Desktop `deleteSession`, call `stopDeveloperDiagnostics()` before awaiting the daemon; this conservatively stops the sole active lease even if an unrelated session is being deleted, preventing reads during deletion and covering child IDs returned later. On any stop cause, remove listeners, clear buffers, and detach if this inspector attached the debugger. Keep the event gate small:

  ```ts
  if (!lease || lease.paused || debuggerSessionId || Date.now() >= lease.expiresAt) return
  if (method === "Network.requestWillBeSent" && params.frameId !== lease.mainFrameId) return
  if (method === "Runtime.consoleAPICalled" &&
      defaultContextFrame.get(params.executionContextId) !== lease.mainFrameId) return
  // Project only approved fields, sanitize, cap, then append to the lease buffer.
  ```

  Name the fourth argument of Electron debugger's `message` callback `debuggerSessionId`, distinct from the Agent's `lease.sessionId`. Fill `defaultContextFrame` only from `Runtime.executionContextCreated` events whose `auxData.isDefault` is true; clear it on navigation. A nonempty `debuggerSessionId` denotes a child target and is ignored.
- [ ] **Step 4: Re-run focused Browser/settings/session tests** and Desktop node typecheck. Simulate late CDP responses and an asynchronous session-tree deletion to ensure the active lease has already stopped before the delete promise settles.
- [ ] **Step 5: Review and commit this task's files.**

### Task 6: Verify the integrated boundary

**Files:** Add only a test or small correction where a concrete gap appears; otherwise no new files.

- [ ] **Step 1: Run** Server Browser tool and permission-broker tests, Desktop settings/permission-card/Browser tests, then `pnpm --filter @vykor/server check-types` and `pnpm --filter @vykor/desktop typecheck`.
- [ ] **Step 2: Run** `node scripts/check-docs.mjs` and `git diff --check`. Review the diff to confirm ordinary `Browser` schema and behavior remain intact, the two pre-existing Browser edits were preserved, and no `minimax-code` dependency or source copy was introduced.
- [ ] **Step 3: Perform one Desktop smoke check** with a synthetic local page: off denies; on plus approval exposes bounded DOM/style results; diagnostics capture requests after approval; off immediately stops capture. If the Desktop UI cannot run in the execution environment, report that limitation and retain the automated checks.
- [ ] **Step 4: Review the final diff and commit any remaining scoped changes** after all required checks pass. Do not start coding until the spec's four-category CDP scope is accepted.

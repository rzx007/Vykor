# Provider Settings Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the desktop provider settings page with transient feedback, a unified data-driven provider list, and a compact refresh control.

**Architecture:** Keep the existing typed desktop provider snapshot boundary and remove the parallel subscription DTO. Provider credential source becomes the single classification used by the renderer. A small timer helper owns notice cleanup so its behavior can be tested without mounting Electron UI.

**Tech Stack:** TypeScript, React 19, Electron, Vitest, Tailwind CSS, shadcn Base UI components

**Spec:** `docs/superpowers/specs/2026-08-19-provider-settings-polish-design.md`

## Global Constraints

- Do not execute or parse `vk auth` or `vk provider`.
- Do not add dependencies or overwrite unrelated dirty-worktree changes.
- Use existing shadcn components and semantic theme tokens.
- Only render subscription providers returned by the existing provider/auth data flow.

---

### Task 1: Remove fixed subscription snapshot records

**Files:**
- Modify: `apps/desktop/src/main/features/provider/provider-service.test.ts`
- Modify: `apps/desktop/src/main/features/provider/provider-service.ts`
- Modify: `apps/desktop/src/shared/provider-types.ts`

**Interfaces:**
- Consumes: `buildDesktopProviderSnapshot({ providers, auth, settings, models })`
- Produces: `DesktopProviderSnapshot` containing only `providers`, `activeProvider`, and `activeModel`; subscription detection is represented by `DesktopProviderInfo.credentialSource === "subscription"`.

- [ ] **Step 1: Write the failing test**

Add literal assertions that the snapshot has no `subscriptions` property and that the detected Codex provider carries the subscription source and account label.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @vykor/desktop test -- src/main/features/provider/provider-service.test.ts`

Expected: FAIL because the snapshot still contains the fixed subscription array.

- [ ] **Step 3: Write minimal implementation**

Delete `DesktopSubscriptionInfo`, `DesktopSubscriptionState`, the `subscriptions` snapshot field, the fixed subscription construction, and `normalizeCodexState`. Keep the existing Codex provider credential-source mapping.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @vykor/desktop test -- src/main/features/provider/provider-service.test.ts`

Expected: PASS.

### Task 2: Add transient provider feedback

**Files:**
- Create: `apps/desktop/src/renderer/src/components/desktop/settings-page/provider-feedback.test.ts`
- Create: `apps/desktop/src/renderer/src/components/desktop/settings-page/provider-feedback.ts`
- Modify: `apps/desktop/src/renderer/src/components/desktop/settings-page/provider-settings.tsx`

**Interfaces:**
- Produces: `scheduleProviderNoticeDismissal(clear: () => void, delayMs: number): () => void`
- Consumes: React effects for success and error state cleanup.

- [ ] **Step 1: Write the failing test**

Use Vitest fake timers to assert the clear callback is not called before the literal delay, is called once at the delay, and is not called after cleanup.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @vykor/desktop test -- src/renderer/src/components/desktop/settings-page/provider-feedback.test.ts`

Expected: FAIL because `provider-feedback.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Implement the scheduling helper, add 4-second success and 6-second error effects, clear prior feedback when refresh begins, and add `AlertAction` close icon buttons with accessible labels.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @vykor/desktop test -- src/renderer/src/components/desktop/settings-page/provider-feedback.test.ts`

Expected: PASS.

### Task 3: Unify and polish the provider UI

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/desktop/settings-page/provider-settings.tsx`

**Interfaces:**
- Consumes: `DesktopProviderSnapshot.providers`, existing connect/activate/disconnect callbacks, shadcn Card, Alert, Badge, Button, Empty, Separator, Spinner, and Tooltip components.
- Produces: one provider section containing connected/detected subscriptions and available providers, plus the current-provider summary and existing dialogs.

- [ ] **Step 1: Replace the fixed subscription section**

Remove `SubscriptionCard` and all `DesktopSubscriptionInfo` imports. Render providers with `credentialSource === "subscription"` in the connected group and omit undetected Codex from the available API-key list.

- [ ] **Step 2: Build the unified card composition**

Use one section heading and one card, with connected and available groups separated by captions and `Separator` components. Keep the expand/collapse action inside the card.

- [ ] **Step 3: Polish hierarchy and spacing**

Apply standard spacing, `shadow-sm`, semantic muted surfaces, rounded icon media, clearer row typography, responsive wrapping, and compact badges without raw colors.

- [ ] **Step 4: Replace the refresh button**

Place an icon-only ghost button in the provider heading, wrap it in `Tooltip`, give it `aria-label="重新检测供应商"`, and animate `RefreshCw` while loading.

- [ ] **Step 5: Run focused tests and lint**

Run the provider tests and ESLint on the touched provider files. Expected: exit 0.

### Task 4: Verify the completed change

**Files:**
- Review only all files changed by Tasks 1-3.

**Interfaces:**
- Consumes: complete implementation.
- Produces: verification evidence and a concise user handoff.

- [ ] **Step 1: Run all relevant desktop tests**

Run the provider service, provider feedback, settings navigation, router, and desktop shortcut tests. Expected: all pass.

- [ ] **Step 2: Run desktop type checks**

Run node and web TypeScript checks. If unrelated repository errors remain, verify that no error points to a touched provider file and report the exact blockers.

- [ ] **Step 3: Run diff and requirements review**

Inspect `git diff --check` and the focused file diffs; confirm all four user requests and the no-CLI constraint are covered.

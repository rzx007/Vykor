# Conversation Attachments Release Closeout Implementation Plan

> **For Codex:** Execute this plan inline in the current branch. Use test-driven development for every behavior change and run each verification command from `D:\code\personal-project\Vykor`.

**Goal:** Add a production-ready attachment storage diagnostics and maintenance page to Desktop Settings without changing attachment storage semantics.

**Architecture:** The renderer consumes the existing `window.desktop.attachments` scan, repair, and garbage-collection methods. Pure helpers turn report fields into display values and grouped issues; one React component owns the scan/maintenance state machine and renders only existing project UI primitives. Every mutation is followed by a fresh scan so the daemon remains the source of truth.

**Tech Stack:** React 19, TypeScript, Vitest, React DOM test utilities, Base UI/Shadcn components, Tailwind CSS, Lucide icons, Electron preload contract.

---

## Task 1: Register the page and lock down display calculations

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/desktop/settings-page/settings-navigation.ts`
- Modify: `apps/desktop/src/renderer/src/components/desktop/settings-page/settings-navigation.test.ts`
- Create: `apps/desktop/src/renderer/src/components/desktop/settings-page/attachment-storage-format.ts`
- Create: `apps/desktop/src/renderer/src/components/desktop/settings-page/attachment-storage-format.test.ts`

### Step 1: Write failing navigation and helper tests

Add assertions for:

- `settingsSectionLabel("storage") === "存储"`;
- `settingsSectionSlug("存储") === "storage"`;
- byte formatting at zero, KB, MB, GB, negative, and non-finite boundaries;
- total asset count across all four states;
- issue grouping by code and severity;
- whether repair and garbage collection actions are available.

### Step 2: Run the focused tests and confirm RED

Run:

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/settings-page/settings-navigation.test.ts src/renderer/src/components/desktop/settings-page/attachment-storage-format.test.ts
```

Expected: failures because storage navigation and helper module do not exist yet.

### Step 3: Implement the smallest pure functions and navigation entry

- Add Lucide `HardDrive` as “存储” under the existing “编码” group.
- Implement `formatBytes`, `totalAssets`, `groupStorageIssues`, `canRepairStorage`, and `canCollectStorage`.
- Keep helpers deterministic and independent from React or `window.desktop`.

### Step 4: Run the focused tests and confirm GREEN

Run the same Vitest command. Expected: all assertions pass.

## Task 2: Implement the settings page state machine and UI

**Files:**

- Create: `apps/desktop/src/renderer/src/components/desktop/settings-page/attachment-storage-settings.tsx`
- Create: `apps/desktop/src/renderer/src/components/desktop/settings-page/attachment-storage-settings.test.tsx`
- Modify: `apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx`

### Step 1: Write failing component tests

Build a small `window.desktop.attachments` mock and cover:

- the page scans once on mount;
- the loading state is accessible;
- a successful report renders actual occupancy, asset count, deduplication savings, reclaimable bytes, and health status;
- initial scan failure renders an error and retry button;
- manual refresh retains existing data while busy;
- safe repair calls `repairStorage()` once, blocks duplicate actions, reports the result, then scans again;
- garbage collection does not run before confirmation;
- cancelling the dialog does not call `gcStorage()`;
- confirming calls `gcStorage()` once, reports full/partial completion, then scans again;
- missing Desktop API produces an unsupported-environment state instead of throwing.

Use semantic queries or DOM role/text assertions. Do not test Tailwind class strings except for one stable responsive overflow regression if necessary.

### Step 2: Run the component test and confirm RED

Run:

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/settings-page/attachment-storage-settings.test.tsx
```

Expected: failure because the component has not been implemented.

### Step 3: Implement the page with existing design primitives

Implement `AttachmentStorageSettings` with:

- one initial scan effect with cancellation protection;
- a reusable scan function that distinguishes first load from refresh;
- mutually exclusive `scan`, `repair`, and `gc` operation state;
- existing `Card`, `Button`, `Badge`, `Alert`, `Skeleton`, `Separator`, and `AlertDialog` components;
- Lucide icons only;
- layout and typography matching `SettingsContent` and `GeneralSettings`;
- a compact overview grid instead of a dashboard-style hero;
- grouped health rows with text labels in addition to color;
- an inline operation-result area that remains visible;
- a destructive confirmation dialog for garbage collection;
- disabled actions when no matching work exists or another operation is active;
- no custom palette values and no hard-coded light-only colors.

Wire `SettingsContent` so “存储” renders this component and uses the description “查看并维护当前设备上的对话附件存储。”

### Step 4: Run the component tests and confirm GREEN

Run the focused Vitest command again. Fix only implementation defects revealed by the tests.

### Step 5: Run Desktop tests and type checks

Run:

```powershell
pnpm --filter @vykor/desktop test
pnpm --filter @vykor/desktop typecheck
```

Expected: both commands exit successfully.

## Task 3: Visual QA, release documentation, and full verification

**Files:**

- Modify: `docs/superpowers/specs/2026-08-29-conversation-attachments-release-closeout-design.md`
- Modify: the existing attachment roadmap/status document identified by `rg "阶段 8|阶段 9|发布收口" docs/superpowers`
- Modify only if needed after visual QA: renderer files from Tasks 1–2

### Step 1: Start the Desktop app and inspect the real page

Run the repository's Desktop dev command in a persistent terminal. Open Settings → Storage and inspect:

- visual continuity with General and Provider settings;
- light and dark themes;
- normal, loading, empty, warning, error, and confirmation-dialog states;
- narrow window behavior;
- keyboard focus order and Escape/cancel behavior;
- large values and long error messages.

Use the real app UI for the final visual decision; do not treat the brainstorm HTML as implementation truth.

### Step 2: Apply only evidence-based visual fixes

If inspection finds a concrete issue, first add or adjust a test when the issue is behavioral, then make the smallest code change. Re-run the focused tests after every fix.

### Step 3: Update closeout documentation

- Change the design status to implemented after verification.
- Record the exact feature boundary, tests run, and any consciously deferred items.
- Update the attachment roadmap so this small release closeout is marked complete without claiming that a future general diagnostics center or binary document conversion is complete.

### Step 4: Run full verification

Run fresh commands:

```powershell
pnpm test
pnpm check-types
pnpm --filter @vykor/desktop lint
git diff --check
git status --short
```

Expected:

- all tests pass;
- all TypeScript checks pass;
- Desktop lint passes;
- no whitespace errors;
- only intended files are modified before the final commit.

### Step 5: Commit the implementation

Commit with a concise message such as:

```text
feat(desktop): add attachment storage settings
```

After the commit, re-run `git status --short --branch` and report the branch, commit, verification counts, and any remaining non-product artifacts.

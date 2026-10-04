# Native Plugin UI A4 Implementation Plan

> **For agentic workers:** Use executing-plans inline. User approved continuous completion, not batch handoffs; no implementation agents or repeated A1/A2/A3 reviews.

**Goal:** Deliver the actual text-inspector reference UI, reproducible author instructions and desktop interaction evidence.

**Architecture:** Keep A3 unchanged except any demonstrated accessibility defect. The existing pure text checker also proposes UI data; a same-plugin pure tool returns selected fixes as a text preview, never writes user files. A browser entry consumes the public SDK and is bundled into a single committed HTML file.

**Tech Stack:** Existing Node/Vite/TypeScript/SDK/Electron; native HTML controls, no new dependency, no external service or real model.

**Spec:** ../specs/2026-10-02-native-plugin-ui-design.md, A4 / UI-24–26 with the user's amendment below.

## Scope and constraints

- 2026-10-04 user removed Converter diagnostics from this task. Do not modify or retire Codex/Claude conversion code. Its possible future retirement is not deletion authorization.
- Reuse existing isolated worktree and branch codex/plugin-ui-a1, base acff63f0. No main merge, remote push, packaging release or user daemon/profile changes.
- Keep original Check content JSON and the 100,000 UTF-16 input limit; UI data is additional host-validated metadata.
- UI exposes at most100 findings. Include text only when encoded preview args fit safely below64KiB; large input still has ordinary results.
- Preview arguments: {text:string, selected:string[]}; IDs are line:code, recomputed in the actual Native tool. Invalid/duplicate/stale selections fail, not partially applied.
- Leading tabs become two spaces each; selected trailing spaces/tabs are removed. Preserve LF/CRLF and unselected content. No filesystem/clipboard writes.
- Actual SDK only, no handwritten port protocol. Parent provides theme/readOnly/actions; no fetch, parent DOM, Node or arbitrary tool calls.
- Readability/keyboard/accessibility inherit the existing desktop's quiet style. Do not create a design system or install components.
- Existing A3 security evidence remains valid; test only changed example/tool/UI and necessary focus behavior.

## Task1: Real reference tools and single-file UI

**Files:** examples/plugins/text-inspector/tools/index.mjs, .vykor-plugin/plugin.json, ui/manifest.json, ui/panel.mjs, ui/panel.template.html, scripts/build-ui.mjs, generated ui/panel.html; packages/agent-runtime/src/native-tools/text-inspector.test.ts.

**Interfaces:** existing TextInspectorCheck({text}) retains {findings,truncated} text. New TextInspectorPreview({text,selected}) returns {text,findings,truncated} text and proposal componentId=text-inspector, data={text,findings,truncated}. UI calls client.requestAction("preview",{text,selected}) and receives snapshots.

- [x] Add a real child-process failing test for Check UI metadata and a missing Preview tool, preserving baseline text assertions.
  `const result = await check.execute({text:"ok  \n\titem\n"},{cwd}); expect(result.metadata.ui.data).toMatchObject({text:"ok  \n\titem\n"});`
- [x] Add literal expected preview assertions for selected fixes / LF / CRLF / unchanged issues and invalid selections; assert no cwd files created.
  `expect(JSON.parse(result.content[0].text).text).toBe("ok\n\titem\n");`
- [x] Implement small shared check/proposal helpers and the pure Preview tool, then run only text-inspector tests and actual SDK example types.
- [x] Build native checkbox/list/preview UI using public createPluginUiClient; stable selected IDs, explicit native action label, status aria-live, local preview display and surface controls.
- [x] Build with existing Vite library mode, reject Node imports, embed JS in template, verify one HTML/no external resources and deterministic rebuild.

## Task2: Author instructions and scope alignment

**Files:** examples/plugins/text-inspector/README.md, skills/check-text/SKILL.md, agents/reviewer.md, references/rules.md; docs/native-plugin-authoring.md and Native UI spec stage status.

- [x] Document SDK build command, actual payloads, permission approval, card/sidebar, user-confirmed preview, copying preview manually, large-input fallback and failure recovery.
- [x] Update obsolete no-permission/no-UI claims without removing original ordinary-tool instructions.
- [x] Explain that UI data contains user-provided text only inside the owned session; no filesystem editing and no automatic model follow-up.
- [x] Record the Converter exemption in the spec; do not alter converter implementation, tests or permissions.
- [x] Run doc link/source checks and changed example compilation.

## Task3: Actual reference-plugin desktop evidence and final handoff

**Files:** packages/server/test-helpers/native-ui-electron.mts, apps/desktop/tests/plugin-ui-electron/reference-ui-check.ts, main.ts, and docs/superpowers/reviews/2026-10-04-native-plugin-ui-a4-verification.md.

- [x] Extend the existing isolated Node backend with an explicit sample mode that installs the actual example directory and seeds a local fixed Check response, not handwritten fake tools.
- [x] Through actual production scheme/main/preload/bridge/SDK, select a finding with keyboard, request preview, cancel confirmation (no UI Run), confirm (one UI Run/no Input/model Attempt), observe real SQLite/SSE text update.
- [x] Open the same instance in sidebar, verify one frame and old frame destroyed; close display preserves business; test focus restoration and Enter/Escape/Space through actual Electron input.
- [x] Check readonly/status/error text and actual light/dark/narrow captures in one bounded inspection. Do not claim user-person manual acceptance from automated screenshots.
- [x] If tests reveal focus defects, write the smallest failing regression and fix only that shared path; no old branch review.
- [x] Run scoped Native sample tests, browser build/types, relevant desktop checks, docs/whitespace; save evidence and local commit.

## Exit

All scoped code and docs complete, actual reference plugin passes real desktop checks; explicitly distinguish automated keyboard+visual review from user-person acceptance and untested platforms. Preserve branch/worktree. No interim batch stop; report only completion or a genuine missing authority.

# TUI Layered Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace TUI placeholder state and silent action loss with typed, tested client-backed behavior, while removing production-only fields that have no data source.

**Architecture:** `useServerSync` owns daemon/client state and exposes named typed actions. `App` owns visual open/closed state. Workflow, MCP and task data come from `@vykor/client`; unsupported Todo/Swarm/Bridge presentation fields leave the production controller instead of remaining permanently empty.

**Tech Stack:** TypeScript, React 19, OpenTUI, Bun test, `@vykor/client`

**Spec:** `docs/superpowers/specs/2026-08-19-layered-cleanup-design.md`

## Global Constraints

- Preserve existing slash commands and transcript rendering.
- Unknown actions must surface an error instead of being silently ignored.
- Clear session-scoped auxiliary data when the active session changes.
- Do not modify Desktop or Runtime packages.

---

### Task 1: Typed actions and Workflow state

**Files:**
- Modify: `apps/frontend/src/hooks/sessionController.ts`
- Modify: `apps/frontend/src/hooks/useServerSync.ts`
- Modify: `apps/frontend/src/App.tsx`
- Test: `apps/frontend/src/hooks/useServerSync.test.tsx`
- Test: `apps/frontend/src/App.test.tsx`

**Interfaces:**
- Produce a `TuiAction` discriminated union covering every supported action, including workflow open/refresh/select/filter/cancel/reconcile operations.
- Produce non-null `workflowState` when client calls return workflow data.

- [ ] Add a failing test proving `workflow_request` currently produces no state or client call.
- [ ] Add a failing test proving an unsupported action reports an error.
- [ ] Replace the untyped action payload with `TuiAction` and an exhaustive switch.
- [ ] Implement workflow client calls using existing transport methods and update `workflowState`.
- [ ] Verify focused hook/App tests, then all frontend tests and typecheck.

### Task 2: Real auxiliary state and removal of permanent placeholders

**Files:**
- Modify: `apps/frontend/src/hooks/sessionController.ts`
- Modify: `apps/frontend/src/hooks/useServerSync.ts`
- Modify: `apps/frontend/src/App.tsx`
- Modify: `apps/frontend/src/routes/session/AppView.tsx`
- Modify: `apps/frontend/src/routes/session/Sidebar.tsx`
- Modify: `apps/frontend/src/routes/session/Footer.tsx`
- Test: `apps/frontend/src/hooks/useServerSync.test.tsx`
- Test: `apps/frontend/src/routes/session/Session.test.tsx`

**Interfaces:**
- `mcpServers` and task state are loaded from existing client APIs for the active session.
- Fields without a current data source are removed from the production controller/view model rather than filled with constants.

- [ ] Add failing tests for MCP/task hydration and active-session reset.
- [ ] Load supported data through `@vykor/client` and project it into the controller.
- [ ] Remove unsupported permanent-empty fields and unreachable presentation branches, preserving transcript-derived historical summaries.
- [ ] Run frontend typecheck, strict unused diagnostics and the full Bun test suite.

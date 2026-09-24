# Runtime Layered Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish single canonical implementations for memory extraction and child worktrees, eliminate extension discovery's hidden global mutation, and split the runtime facade without changing its public behavior.

**Architecture:** Stateless memory rules live in the memory leaf package; runtime/services adapt inputs. Extension discovery returns data without activation side effects. Child worktrees remain owned by agent-runtime. The agent facade delegates run state and composition to internal modules while preserving exports and cleanup order.

**Tech Stack:** TypeScript, Vitest, Git worktrees, Vykor workspace packages

**Spec:** `docs/superpowers/specs/2026-08-19-layered-cleanup-design.md`

## Global Constraints

- `agent-runtime` must not depend on server, services or daemon packages.
- Preserve public SDK exports and event/lifecycle semantics.
- Do not delete an externally consumable package solely from local `rg` evidence.
- Every state-ownership change needs a multi-cwd or failure-path regression test.

---

### Task 1: Canonical memory extraction rules

**Files:**
- Create: `packages/memory/src/extraction.ts`
- Modify: `packages/memory/src/index.ts`
- Modify: `packages/agent-runtime/src/memory-runtime.ts`
- Modify: `packages/services/src/memory-extract.ts`
- Test: `packages/memory/src/extraction.test.ts`
- Test: `packages/agent-runtime/src/memory-runtime.test.ts`
- Test: `packages/services/src/memory-extract.test.ts`

**Interfaces:**
- Shared pure functions build extraction input, parse noisy JSON records, normalize defaults, filter team scope and cap results at three.
- Runtime/services retain model streaming and `MemoryManager.add()` adaptation.

- [ ] Add cross-path failing fixtures for malformed JSON, defaults, team filtering, cap and prior memory writes.
- [ ] Implement pure extraction helpers in `@vykor/memory`.
- [ ] Replace both duplicated algorithms with adapters.
- [ ] Run memory, services and agent-runtime tests/typechecks.

### Task 2: Pure extension discovery and scoped activation

**Files:**
- Modify: `packages/agent-runtime/src/extensions.ts`
- Modify: `packages/agent-runtime/src/agent.ts` or the new composition module from Task 4
- Modify: `packages/coordinator/src/agent-definitions.ts`
- Modify: command/context callers under `packages/server/src`
- Test: `packages/agent-runtime/src/extensions.test.ts`
- Test: coordinator/server focused tests

**Interfaces:**
- `discoverVykorExtensions(cwd, settings)` has no registry mutation.
- Activation is explicit and scoped to the agent/runtime that consumes definitions.

- [ ] Add a failing two-cwd test proving read-only discovery currently overwrites definitions.
- [ ] Separate discovery from activation and remove mutation from command/context reads.
- [ ] Make agent definition consumption scoped or injected rather than last-writer process global.
- [ ] Run runtime, coordinator and server focused tests.

### Task 3: Worktree canonical and compatibility boundary

**Files:**
- Modify: `packages/swarm/src/worktree.ts` and its barrel/tests, or add deprecation documentation if a safe thin adapter is impossible
- Modify: `packages/swarm/README.md`
- Test: `packages/agent-runtime/src/child-environment.test.ts`
- Test: `packages/swarm/src/worktree.test.ts` when retained

**Interfaces:**
- `agent-runtime/src/child-environment.ts` remains the canonical implementation.
- Swarm cannot keep an independently evolving copy.

- [ ] Add runtime canonical tests for existing/dirty worktrees and normalized Windows paths where feasible.
- [ ] Replace the duplicate with a compatibility adapter or remove only the redundant export when workspace compatibility permits.
- [ ] Run runtime and swarm tests/typechecks plus a full import scan.

### Task 4: Split agent facade, run state and composition

**Files:**
- Modify: `packages/agent-runtime/src/agent.ts`
- Create: `packages/agent-runtime/src/framework-agent-run.ts`
- Create: `packages/agent-runtime/src/agent-composition.ts`
- Create: `packages/agent-runtime/src/agent-errors.ts`
- Test: existing `packages/agent-runtime/src/*.test.ts`
- Test: add focused factory failure tests under `packages/agent-runtime/src/agent.test.ts`

**Interfaces:**
- Public exports remain sourced from `agent.ts`/`index.ts` with identical signatures.
- Cleanup order remains interrupt active run → await maintenance → close children → drain events → close runtime.

- [ ] Add failing factory cleanup tests for extension setup and MCP connection failure.
- [ ] Move helpers, run state and composition without rewriting state transitions.
- [ ] Keep the facade thin and preserve public types.
- [ ] Run all runtime tests and dependent server/CLI focused tests.

# User-scoped Native Plugin installation implementation plan

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** Remove project-local Native Plugin installation semantics and prevent stale installation records from authorizing different cached content.

**架构：** Local installation has one user-scoped record per plugin ID that points to an immutable version-and-digest cache snapshot. The installer records a behavior digest for copied content, legacy narrower records are ignored with diagnostics, and every plugin consumer uses one shared verifier for cached identity, version, permissions, and digest before loading contributions.

**技术栈：** TypeScript, Node.js filesystem/crypto APIs, Vitest, pnpm workspace.

---

## Files

- `packages/plugins/src/installation/installer.ts`: enforce user-only installation and persist copied-content digest.
- `packages/plugins/src/installation/cache.ts`: materialize immutable snapshots, reject redirected snapshot roots, and repair corrupted snapshots during reinstall.
- `packages/plugins/src/installation/verify.ts`: provide shared installed-record verification for every plugin consumer.
- `packages/plugins/src/installation/store.ts`: represent legacy records, return globally applicable records plus legacy warnings.
- `packages/plugins/src/installation/__test__/installer.test.ts`: installer scope and digest regression tests.
- `packages/plugins/src/installation/__test__/store.test.ts`: legacy discovery warning tests.
- `packages/agent-runtime/src/node/plugins/extensions.ts`: verify the actual cached plugin against its record before loading.
- `packages/agent-runtime/src/node/plugins/extensions.test.ts`: runtime fail-closed and link behavior tests.
- `packages/server/src/application/settings-api.ts`, `packages/server/src/http/routes/service.ts`: user-only service contract and request validation.
- `packages/server/src/application/default-services/plugin-service.ts`: global user-record management and legacy warnings.
- `packages/client/src/transport/http-client.ts`: user-only client installation contract.
- `apps/cli/src/commands/plugin.ts`, `apps/cli/src/commands/plugin.test.ts`: remove scope selection and assert user-only CLI behavior.
- affected server/client tests and converted-plugin acceptance fixtures: update callers to the user-only contract.

### Task 1: Lock installation and discovery to user scope

- [x] Add tests proving `installLocalNativePlugin` rejects project/local scope and copied installs persist their behavior digest.
- [x] Run the focused plugin tests and confirm they fail because the current API accepts narrower scopes and records no digest.
- [x] Narrow the install input to user scope, add a defensive runtime scope check, and persist the digest only for copied installs.
- [x] Add a discovery test with user, project, and local records that expects only the user record plus explicit reinstall warnings.
- [x] Change discovery to return records and warnings while retaining legacy store decoding.
- [x] Run the focused plugin tests until green.

### Task 2: Verify cached behavior before runtime activation

- [x] Add runtime tests for valid copied installs, missing/mismatched digest, ID/version mismatch, permission mismatch, and mutable links.
- [x] Run the focused runtime tests and confirm each new security assertion fails for the intended missing check.
- [x] Implement one verification helper that validates the actual manifest, recomputes requested permissions, checks approvals, and verifies copied-content digests before calling `loadNativePlugin`.
- [x] Propagate discovery warnings into the runtime result.
- [x] Run plugin and runtime tests until green.

### Task 3: Remove project/local scope from external install APIs

- [x] Add or update HTTP and CLI tests proving non-user scope is rejected and install commands no longer expose `--scope`.
- [x] Run focused server and CLI tests and confirm the old contract fails those assertions.
- [x] Narrow server/client types, require `scope: "user"` at the HTTP boundary, and make CLI install/link/convert send user scope without an option.
- [x] Update converted-plugin acceptance and other compile-time callers to user scope.
- [x] Make list/enable/disable/uninstall operate on globally applicable user/managed records and report ignored legacy records.
- [x] Add route tests proving installation-state mutations acquire the global lease and close all runtimes.
- [x] Run the focused tests until green.

### Task 4: Verification and review

- [x] Run all tests for plugins, agent-runtime, server, client, CLI, plugin-converters, and desktop packages.
- [x] Run type checking for every affected package.
- [x] Inspect `git diff --check` and the exact diff to ensure unrelated working-tree changes were not modified.
- [x] Request an independent code review against this design and fix its first-round cache TOCTOU and verifier-bypass findings.
- [x] Add and pass review regressions for redirected cache roots, corrupted-snapshot reinstall recovery, and runtime recovery after reinstall.
- [x] Add and pass review regressions for post-install snapshot-root links and digest failures caused by nested links.
- [x] Confirm through the final independent re-review that no Critical or Important findings remain.
- [x] Re-run the complete affected test and type-check set after review fixes.

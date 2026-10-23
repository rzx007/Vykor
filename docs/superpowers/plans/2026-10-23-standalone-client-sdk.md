# Standalone Client SDK Implementation Plan

> **For agentic workers:** Execute this approved scope inline, one task at a time, with a review checkpoint after each verification. The user has authorized implementation, build/release tooling, local service management, and documentation.

**Goal:** Make `@rzx/client` installable outside this repository, including a Node-only local service entry and a verified publishing path.

**Architecture:** Preserve the existing browser-safe client and durable session protocol. Bundle runtime code and public declarations so consumers need no workspace packages. Add a separate Node service entry that reads the daemon registry, verifies protocol/authentication, and starts an explicitly resolved CLI command without importing the server.

**Tech Stack:** TypeScript, esbuild, Rollup declarations, Vitest, Node test runner, npm pack.

**Spec:** User request in this conversation, 2026-10-23: independent install, build/release, local service management, and usage docs.

## Global Constraints

- Preserve unrelated in-progress directory organization changes in the shared checkout.
- Keep tests under the owning directory's `__test__/`; add README navigation for new categories.
- Keep `@rzx/client` browser-compatible; import local management only from `@rzx/client/service`.
- Do not publish to npm or modify the user's running daemon during verification.
- Preserve current resource APIs, protocol checks, and session synchronization semantics.

## Task 1: Local service management

Files: `packages/client/src/service/{index,registry,service}.ts`, category README and `__test__/service.test.ts`.

Interface: `Service.discover(options)`, `Service.ensure(options)`, `Service.stop(endpoint, options)`, `Service.clientOptions(endpoint)`; endpoint includes the registry file and exact process identity.

- [x] Add tests with isolated registry files and a real HTTP child-process fixture: discover without starting; authenticate; reject incompatible protocol/version; concurrent ensure shares startup; timeout/abort/failure; stop refuses replaced registry identities.
- [x] Run the new tests before implementation and confirm the missing entry fails.
- [x] Implement registry validation, bounded probing, explicit command startup and exact-instance stop. Default command resolves the consuming application's installed `@rzx/ohs`; custom commands run with no shell.
- [x] Run service tests and client type checks.

## Task 2: Installable artifacts

Files: `packages/client/package.json`, `packages/client/scripts/{build,verify-pack}.mjs`, scripts README, lockfile.

- [x] Add external package verification that installs an npm tarball into a clean temporary project and executes Node, type, browser, and service entry consumers.
- [x] Confirm verification fails against current source-only exports.
- [x] Bundle browser and Node entries into `dist`, including self-contained declaration files; declare only build dependencies and no workspace runtime dependencies in the published manifest.
- [x] Keep workspace protocol as a development dependency for repository source builds.
- [x] Verify package consumers resolve no unpublished Vykor package, native addon, or server implementation.

## Task 3: Release and documentation

Files: client release script/tests/workflow, root scripts, client README, `docs/client-sdk.md`, docs and release navigation.

- [x] Test release argument validation and dry-run behavior without network publishing.
- [x] Provide an explicit-version release command and CI workflow which builds, verifies the packed artifact, then publishes using npm trusted publishing only when manually triggered.
- [x] Document installation, connecting, local service setup, submissions/results, permissions, cancellation, reconnection, version compatibility, custom command/registry, and publishing.
- [x] Run client tests/types, package verification, public API/browser checks, architecture, retired UI and docs checks; review the final diff for secrets and unrelated changes.

## Verification evidence

- Client suite: 180 tests passed; release script: 2 tests passed.
- Server/client integration: 124 tests passed; server/client TypeScript check passed.
- Real tarball: external Node client/service execution, NodeNext and Bundler public declarations, and browser build passed.
- `pnpm release:client:dry -- 0.1.0` passed after the final build, including license notices; no package uploaded.
- Client type check, public API contract, source browser build, architecture boundaries, clean-slate, retired UI and docs checks passed.
- Independent review reproduced and verified fixes for probe socket cancellation, joining-caller cancellation and duplicate cross-instance startup. Final focused review found no remaining blocker.
- Existing directory organization work was preserved. Exact retired-reference line entries were updated where concurrent documentation/script edits shifted unchanged text.

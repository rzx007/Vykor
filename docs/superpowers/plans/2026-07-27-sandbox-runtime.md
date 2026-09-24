# Vykor TS Sandbox Runtime Implementation Plan

> 状态：历史计划。Docker Agent Runtime 已移除；当前方案见 [Native / WSL 智能体运行环境设计](../specs/2026-09-07-native-wsl-execution-environment-design.md)。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or an equivalent checklist-driven implementation loop. Update checkboxes as work completes.

**Goal:** Port the Python Vykor sandbox execution model into TS: a configurable sandbox layer for shell execution, Docker network modes, and host file-tool boundary checks.

**Architecture:** Build the feature in layers. First expand settings and pure sandbox helpers. Then add process/session adapters. Then route `Bash` through a shared shell helper. Finally protect host-side file tools and wire runtime lifecycle.

**Reference design:** [docs/sandbox-runtime-design.md](../../sandbox-runtime-design.md)

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Modify | `packages/core/src/types/settings.ts` | Extend `SandboxConfig` and nested config types |
| Modify | `packages/core/src/config/settings.ts` | Defaults and environment overrides |
| Replace | `packages/sandbox/src/index.ts` | Public exports |
| Create | `packages/sandbox/src/types.ts` | Shared sandbox types |
| Create | `packages/sandbox/src/platform.ts` | Platform detection and support matrix |
| Create | `packages/sandbox/src/availability.ts` | Backend availability checks |
| Create | `packages/sandbox/src/path-validator.ts` | Sandbox filesystem boundary checks |
| Create | `packages/sandbox/src/srt-adapter.ts` | `srt` argv wrapping and temp config |
| Create | `packages/sandbox/src/docker-backend.ts` | Docker argv/session helpers |
| Create | `packages/sandbox/src/session.ts` | Active sandbox session registry |
| Create | `packages/sandbox/src/shell.ts` | Shared shell command spawning |
| Modify | `packages/tools/package.json` | Add `@vykor/sandbox` dependency |
| Modify | `packages/tools/src/shell/bash.ts` | Route through shared sandbox-aware shell helper |
| Modify | `packages/tools/src/file/{read,write,edit,glob,grep}.ts` | Apply sandbox path validation when active |
| Modify | `apps/cli/src/runtime.ts` | Pass runtime settings into tool execution context |
| Modify | docs and tests | Keep behavior documented and covered |

---

## Task 0: Planning and Scope Guard

- [x] Write high-level design spec.
- [x] Compare Python original behavior.
- [x] Write implementation plan.
- [x] Self-review plan for risk and completeness.

Exit criteria:

- Plan separates safe pure helpers from runtime/container operations.
- MVP avoids doing real Docker network work unless tests explicitly mock it.
- Native Windows behavior is explicit and fail-closed when required.

---

## Task 1: Settings Schema and Defaults

**Purpose:** Make sandbox configuration expressive enough before implementation code consumes it.

- [x] Extend `SandboxConfig` with `backend`, `enabledPlatforms`, `filesystem`, `network`, `docker`, and `srt`.
- [x] Preserve backward compatibility for existing `runtime?: string` by treating it as an alias or deprecated field.
- [x] Add defaults matching the design:
  - `enabled: false`
  - `backend: "srt"`
  - `failIfUnavailable: false`
  - `network.mode: "none"`
  - filesystem read/write allow defaults to `"."`
- [x] Add env overrides:
  - `VYKOR_SANDBOX_ENABLED`
  - `VYKOR_SANDBOX_BACKEND`
  - `VYKOR_SANDBOX_FAIL_IF_UNAVAILABLE`
  - `VYKOR_SANDBOX_NETWORK_MODE`
  - `VYKOR_SANDBOX_DOCKER_IMAGE`
- [x] Add core settings tests for defaults and env overrides.

---

## Task 2: Sandbox Pure Helpers

**Purpose:** Implement deterministic helpers that do not start processes.

- [x] Replace `packages/sandbox/src/index.ts` stub with public exports.
- [x] Add platform detection:
  - `linux`, `wsl`, `macos`, `windows`, `unknown`
  - native Windows unsupported for MVP.
- [x] Add `normalizeSandboxConfig(settings)` to fill nested defaults.
- [x] Add `validateSandboxPath(path, options)`:
  - canonicalize paths.
  - reject outside root.
  - reject symlink escape.
  - honor extra allowed roots.
  - apply deny before allow.
- [x] Unit test path validator thoroughly.

---

## Task 3: Availability Checks

**Purpose:** Answer "would sandbox be usable here?" without starting sessions.

- [x] Implement `getSandboxAvailability(settings)`.
- [x] Implement `getSrtAvailability(settings)`:
  - require `srt`.
  - require `bwrap` on Linux/WSL.
  - require `sandbox-exec` on macOS.
- [x] Implement `getDockerAvailability(settings)`:
  - require `docker`.
  - optionally check daemon with `docker info`.
  - native Windows unavailable.
- [x] Make daemon checks injectable/mocked for tests.
- [x] Unit test disabled, unavailable, unsupported, and happy paths.

---

## Task 4: srt Adapter

**Purpose:** Match Python's `srt --settings <file> -c <escaped command>` wrapper.

- [x] Implement `buildSrtRuntimeConfig(settings)`.
- [x] Implement `wrapCommandForSrt(argv, settings)`.
- [x] Write temp settings JSON.
- [x] Return cleanup function for temp file deletion.
- [x] Preserve child exit code behavior via single command string.
- [x] Unit test config mapping, argv shape, and cleanup.

---

## Task 5: Docker Session Backend

**Purpose:** Build Docker command/session behavior with configurable network mode.

- [x] Implement Docker run argv builder.
- [x] Support network modes:
  - `none`: `--network none`
  - `bridge`: `--network bridge`
  - `host`: `--network host` only on Linux/WSL
  - `proxy`: unavailable in MVP unless implemented later
- [x] Enforce `strictDomainPolicy`:
  - domain rules + `bridge`/`host` fail closed when strict.
  - domain rules + non-strict emit warning metadata.
- [x] Implement `DockerSandboxSession.start()`.
- [x] Implement `stop()` and best-effort `stopSync()`.
- [x] Implement `execCommand(argv, options)`.
- [x] Unit test argv shape and strict network policy.

---

## Task 6: Sandbox-Aware Shell Helper

**Purpose:** Centralize command execution so `Bash`, hooks, tasks, and future shell users do not duplicate sandbox logic.

- [x] Add `createShellProcess(command, options)` in `@vykor/sandbox`.
- [x] Resolve shell argv consistently with current `Bash` behavior.
- [x] Route Docker active sessions through `docker exec`.
- [x] Route srt through command wrapping.
- [x] If unavailable:
  - fail when `failIfUnavailable=true`.
  - degrade to host execution when false.
- [x] Keep timeout handling in `Bash` for now to minimize churn.
- [x] Unit test using mocked spawn/session.

### 2026-08-12 收口

- [x] 增加 argv 入口 `createProcess(argv, options)`，与 shell 入口共享 backend/session/fail-closed 规则。
- [x] TaskManager shell/argv、autodream、command hooks、Cron/RemoteTrigger、LSP ripgrep 接入统一入口。
- [x] Cron 手动触发与定时触发统一为 `CronScheduler.trigger()` / `executeJob()`，不再重复维护 `exec`、历史和超时逻辑。
- [x] 增加 argv 路由、per-session Docker、Task/Hook/Cron fail-closed 测试。
- [x] Docker 命令使用容器内独立进程组；Abort、TaskStop、Bash timeout 和 runtime stop 都能清理命令及其子进程。
- [x] 增加 Docker Abort 与可复用 runtime stop 的真实进程树 E2E；本轮因 Docker daemon 未启动而跳过，等待 CI/可用环境执行。
- [x] 删除独立 cron daemon；Cron 改由主 daemon 启动、停止并通过自己的 Sandbox scope 执行。
- [x] 主 daemon 支持 Windows 计划任务、macOS LaunchAgent 和 Linux systemd user service；当前用户登录后启动，异常退出后由系统重启。没有主 daemon 时不执行 Cron。
- [x] MCP stdio transport 通过 `SandboxStdioClientTransport` 接入 `createProcess`。
- [x] `Read` / `Write` / `Edit` / `Glob` / `Grep` 接入 `FileOperations`；Docker active 时真实读写和搜索进容器。
- [x] 文件工具和 MCP stdio 的真实 Docker E2E 进入下一阶段。

---

## Task 7: Bash Tool Integration

**Purpose:** Move `Bash` onto the sandbox-aware helper without changing user-visible output.

- [x] Add `@vykor/sandbox` dependency to `@vykor/tools`.
- [x] Replace direct `spawn(shell, ["-c", command])` with `createShellProcess`.
- [x] Preserve output merging, timeout, truncation, UTF-16LE decoding, and kill-tree behavior.
- [x] Return clear tool error for `SandboxUnavailableError`.
- [x] Update Bash tests.

---

## Task 8: Host File Tool Boundary Checks

**Purpose:** Match the agreed model: file tools remain host-side but cannot escape sandbox boundaries.

- [x] Add helper `guardSandboxPathForTool(toolName, path, context, operation)`.
- [x] Apply it to:
  - `Read`
  - `Write`
  - `Edit`
  - `Glob`
  - `Grep`
- [x] Keep existing system path hard-deny rules.
- [x] Add tests:
  - allowed project path.
  - outside path rejected when sandbox active.
  - behavior unchanged when sandbox disabled.

### 2026-08-12 文件工具容器化收口

- [x] Add `FileOperations` with host and Docker implementations.
- [x] Route `Read` / `Write` / `Edit` through Docker file helper when a Docker sandbox session is active.
- [x] Route `Glob` / `Grep` through container `rg` when a Docker sandbox session is active.
- [x] Keep host fallback for sandbox off/degraded mode.
- [x] Add unit tests proving Docker active file tools use the sandbox session instead of host IO/search.
- [x] Add real Docker E2E for file tools.

### 2026-08-12 MCP stdio Docker E2E

- [x] Add `@vykor/mcp` Docker E2E for sandbox stdio startup.
- [x] Verify JSON-RPC stdio roundtrip from a server running inside Docker.
- [x] Verify Docker cwd path mapping and mounted file visibility.

---

## Task 9: Runtime Lifecycle Wiring

**Purpose:** Start sandbox sessions once per runtime, stop them cleanly.

- [x] Start sandbox in CLI/TUI runtime bootstrap after settings/session ID are known.
- [x] Stop sandbox in runtime close.
- [x] Add process exit safety hooks for Docker.
- [x] Emit or expose sandbox status:
  - `off`
  - `active`
  - `degraded`
  - `unavailable`
- [x] Avoid real Docker startup in unit tests; use mocked backend.
- [x] Pass runtime `settings` into `ToolContext` so tools do not need to infer global config.

---

## Task 10: Documentation and Verification

- [x] Update `docs/sandbox-runtime-design.md` if implementation differs.
- [x] Update `docs/sandbox-runtime-flow.md` and `packages/sandbox/README.md` for MCP stdio and Docker file operations.
- [x] Add `@vykor/tools` and `@vykor/mcp` Docker E2E scripts.
- [ ] Update README or `docs/permission-flow.md` with sandbox/permission relationship.
- [x] Run focused tests:
  - `pnpm --filter @vykor/core test`
  - `pnpm --filter @vykor/sandbox test`
  - `pnpm --filter @vykor/tools test`
- [x] Run focused type checks:
  - `pnpm --filter @vykor/core check-types`
  - `pnpm --filter @vykor/sandbox check-types`
  - `pnpm --filter @vykor/tools check-types`

---

## Self-Review

Checklist:

- Scope is incremental: yes. The first implementation steps are settings and pure helpers only.
- Risky external actions avoided: yes. Docker daemon calls are designed as mockable, and real Docker E2E is separate.
- Existing permission semantics preserved: yes. Sandbox is an execution/path boundary after permission approval.
- Windows behavior explicit: yes. Native Windows is unavailable for MVP; WSL is the supported path.
- User's network question addressed: yes. `bridge` is the pragmatic bridge mode; `proxy` is the future strict domain mode.
- User's file-tool question addressed: yes. File tools stay host-side but must respect sandbox path validation.
- Testability sufficient: yes. Each backend has argv/pure tests before any real E2E.

Self-review verdict: pass. Start implementation at Task 1.

import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { homedir } from "node:os"
import { promisify } from "node:util"
import { app, dialog } from "electron"
import { createDesktopGitWorktree } from "@vykor/server"
import type {
  GitDetection,
  GitIdentity,
  GitPreferences,
  GitSettingsScope,
  GitSettingsSnapshot,
  ManagedGitWorktree,
  UpdateGitIdentityInput,
} from "../../../shared/git-settings-types"
import { desktopSessionService } from "../session/session-service"
import {
  getGitPreferences,
  getGitSettings,
  saveGitPreferences,
  updateGitWorktrees,
  type GitWorktreeRecord,
} from "./git-settings-storage"
import { desktopRuntimeSettingsService } from "./runtime-settings-service"

const exec = promisify(execFile)
type GitCleanupRecord = GitWorktreeRecord & { directoryRemovedAt?: number }
async function directoryMissing(path: string) {
  try {
    await lstat(path)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
    throw error
  }
}
interface Environment {
  kind: "native" | "wsl"
  distribution?: string
  env?: Record<string, string>
}
async function git(
  args: string[],
  cwd: string | undefined,
  environment: Environment = { kind: "native" }
) {
  if (environment.kind === "wsl") {
    const distribution = environment.distribution
      ? ["--distribution", environment.distribution]
      : []
    const linuxCwd = cwd ? await gitPath(cwd, environment) : undefined
    return (
      await exec(
        "wsl.exe",
        [
          ...distribution,
          ...(linuxCwd ? ["--cd", linuxCwd] : []),
          "--exec",
          "env",
          ...Object.entries(environment.env ?? {}).map(([key, value]) => `${key}=${value}`),
          "git",
          ...args,
        ],
        { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }
      )
    ).stdout
  }
  return (
    await exec("git", args, {
      cwd,
      env: { ...process.env, ...environment.env },
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    })
  ).stdout
}
async function gitPath(path: string, environment: Environment) {
  if (environment.kind !== "wsl") return path
  return (
    await exec(
      "wsl.exe",
      [
        ...(environment.distribution ? ["--distribution", environment.distribution] : []),
        "--exec",
        "wslpath",
        "-a",
        path,
      ],
      { windowsHide: true, timeout: 15_000 }
    )
  ).stdout.trim()
}
function recordEnvironment(record: GitWorktreeRecord): Environment {
  return { kind: record.environment ?? "native", distribution: record.distribution }
}
async function hostGitPath(path: string, environment: Environment) {
  if (environment.kind !== "wsl") return path
  return (
    await exec(
      "wsl.exe",
      [
        ...(environment.distribution ? ["--distribution", environment.distribution] : []),
        "--exec",
        "wslpath",
        "-w",
        path,
      ],
      { windowsHide: true, timeout: 15_000 }
    )
  ).stdout.trim()
}
async function configFile(
  scope: "global" | "project",
  cwd: string | undefined,
  environment: Environment
) {
  if (scope === "project") {
    const common = (
      await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd, environment)
    ).trim()
    return join(await hostGitPath(common, environment), "config")
  }
  if (environment.kind === "wsl") {
    const script =
      'if [ -n "${GIT_CONFIG_GLOBAL-}" ]; then printf "%s" "$GIT_CONFIG_GLOBAL"; elif [ -f "$HOME/.gitconfig" ]; then printf "%s/.gitconfig" "$HOME"; elif [ -f "${XDG_CONFIG_HOME:-$HOME/.config}/git/config" ]; then printf "%s/git/config" "${XDG_CONFIG_HOME:-$HOME/.config}"; else printf "%s/.gitconfig" "$HOME"; fi'
    const path = (
      await exec(
        "wsl.exe",
        [
          ...(environment.distribution ? ["--distribution", environment.distribution] : []),
          "--exec",
          "env",
          ...Object.entries(environment.env ?? {}).map(([key, value]) => `${key}=${value}`),
          "sh",
          "-c",
          script,
        ],
        { windowsHide: true, timeout: 15_000 }
      )
    ).stdout.trim()
    return hostGitPath(path, environment)
  }
  const env = { ...process.env, ...environment.env }
  if (env.GIT_CONFIG_GLOBAL !== undefined) {
    if (!env.GIT_CONFIG_GLOBAL) throw new Error("全局 Git 配置已被环境变量禁用。")
    return resolve(env.GIT_CONFIG_GLOBAL)
  }
  const homeDirectory = env.HOME ?? homedir()
  const dotConfig = resolve(homeDirectory, ".gitconfig")
  const xdgConfig = resolve(env.XDG_CONFIG_HOME ?? join(homeDirectory, ".config"), "git", "config")
  const dotExists = await stat(dotConfig)
    .then(() => true)
    .catch((error) => {
      if (error.code === "ENOENT") return false
      throw error
    })
  const xdgExists = await stat(xdgConfig)
    .then(() => true)
    .catch((error) => {
      if (error.code === "ENOENT") return false
      throw error
    })
  return dotExists ? dotConfig : xdgExists ? xdgConfig : dotConfig
}
async function saveIdentityAtomically(
  input: UpdateGitIdentityInput,
  cwd: string | undefined,
  environment: Environment
) {
  const configuredPath = await configFile(input.scope, cwd, environment)
  await mkdir(dirname(configuredPath), { recursive: true })
  const target = await realpath(configuredPath).catch((error) => {
    if (error.code === "ENOENT") return configuredPath
    throw error
  })
  const locks: string[] = []
  try {
    // Match Git's own config lock, also preserving an existing configuration symlink.
    for (const path of [...new Set([configuredPath, target])]) {
      const lock = `${path}.lock`
      const handle = await open(lock, "wx", 0o600).catch((error) => {
        if (error.code === "EEXIST") throw new Error("Git 配置正在被其他程序修改，请稍后重试。")
        throw error
      })
      await handle.close()
      locks.push(lock)
    }
    const old = await identity(input.scope, cwd, environment)
    if (old.configuredName !== input.expectedName || old.configuredEmail !== input.expectedEmail)
      throw new Error("提交身份已被修改，请重新读取后保存。")
    const lock = `${target}.lock`
    const original = await readFile(target).catch((error) => {
      if (error.code === "ENOENT") return Buffer.alloc(0)
      throw error
    })
    const handle = await open(lock, "w")
    try {
      await handle.writeFile(original)
      const mode = await stat(target).catch(() => null)
      if (mode) await handle.chmod(mode.mode & 0o777)
    } finally {
      await handle.close()
    }
    const path = await gitPath(lock, environment)
    await git(
      ["config", "--file", path, "--replace-all", "user.name", input.name.trim()],
      cwd,
      environment
    )
    await git(
      ["config", "--file", path, "--replace-all", "user.email", input.email.trim()],
      cwd,
      environment
    )
    await rename(lock, target)
  } finally {
    await Promise.all(locks.map((path) => unlink(path).catch(() => {})))
  }
}
async function configValue(args: string[], cwd: string | undefined, environment: Environment) {
  try {
    return (await git(["config", ...args], cwd, environment)).trim()
  } catch (error) {
    if ((error as { code?: number }).code === 1) return ""
    throw error
  }
}
async function detection(environment: Environment): Promise<GitDetection> {
  try {
    const version = (await git(["--version"], undefined, environment)).trim()
    let executable: string
    if (environment.kind === "wsl") {
      executable = (
        await exec(
          "wsl.exe",
          [
            ...(environment.distribution ? ["--distribution", environment.distribution] : []),
            "--exec",
            "env",
            ...Object.entries(environment.env ?? {}).map(([key, value]) => `${key}=${value}`),
            "sh",
            "-c",
            "command -v git",
          ],
          { windowsHide: true, timeout: 15_000 }
        )
      ).stdout.trim()
    } else if (process.platform === "win32") {
      executable = (
        await exec("where.exe", ["git"], {
          env: { ...process.env, ...environment.env },
          windowsHide: true,
          timeout: 15_000,
        })
      ).stdout
        .trim()
        .split(/\r?\n/)[0]!
    } else {
      executable = (
        await exec("sh", ["-c", "command -v git"], {
          env: { ...process.env, ...environment.env },
          timeout: 15_000,
        })
      ).stdout.trim()
    }
    return {
      environment: environment.kind,
      distribution: environment.distribution,
      available: true,
      version,
      executable,
    }
  } catch (error) {
    return {
      environment: environment.kind,
      distribution: environment.distribution,
      available: false,
      error: message(error),
    }
  }
}
async function identity(
  scope: "global" | "project",
  cwd: string | undefined,
  environment: Environment
): Promise<GitIdentity> {
  const values = await Promise.all(
    ["name", "email"].map(async (field) => {
      const configured = await configValue(
        [scope === "global" ? "--global" : "--local", "--get", `user.${field}`],
        cwd,
        environment
      )
      const effective = await configValue(
        [
          ...(scope === "global" ? ["--global"] : []),
          "--show-origin",
          "--show-scope",
          "--get",
          `user.${field}`,
        ],
        cwd,
        environment
      )
      const [configScope, origin, ...rest] = effective.split("\t")
      const variable = field === "name" ? "GIT_AUTHOR_NAME" : "GIT_AUTHOR_EMAIL"
      const override =
        environment.env?.[variable] ??
        (environment.kind === "native" ? process.env[variable] : undefined)
      return {
        configured,
        value: override ?? rest.join("\t"),
        source:
          override !== undefined
            ? "环境变量覆盖"
            : effective
              ? `${configScope === "local" ? "当前项目" : configScope === "global" ? "用户全局" : configScope} · ${origin}`
              : "未配置",
      }
    })
  )
  return {
    configuredName: values[0]!.configured,
    configuredEmail: values[1]!.configured,
    name: { value: values[0]!.value, source: values[0]!.source },
    email: { value: values[1]!.value, source: values[1]!.source },
  }
}
export function isInsideGitDirectory(parent: string, child: string) {
  const path = relative(parent, child)
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
}
export function worktreeCleanupAllowed(input: {
  active: boolean
  dirty: boolean | null
  preserved: boolean
  disposable: boolean
  verified: boolean
}) {
  return (
    input.verified &&
    !input.active &&
    input.dirty === false &&
    (input.preserved || input.disposable)
  )
}
export class GitSettingsService {
  private identitySave: Promise<unknown> = Promise.resolve()
  private cleaning = new Set<string>()
  async scope(input: GitSettingsScope = {}) {
    if (
      !input ||
      (input.environment !== undefined &&
        input.environment !== "native" &&
        input.environment !== "wsl") ||
      (input.projectId !== undefined &&
        (typeof input.projectId !== "string" || !input.projectId.trim()))
    )
      throw new Error("请选择有效项目和 Git 环境。")
    const client = await desktopSessionService.daemonClient()
    const project = input.projectId
      ? (await client.projects.list()).find((item) => item.id === input.projectId)
      : undefined
    if (input.projectId && !project) throw new Error("选定项目不存在。")
    const runtime = await desktopRuntimeSettingsService.snapshot({ cwd: project?.path })
    const agent: Environment = {
      kind: runtime.effective.kind,
      distribution: runtime.effective.distribution,
      env: runtime.effective.env,
    }
    const environment: Environment =
      input.environment === "native"
        ? agent.kind === "native"
          ? agent
          : { kind: "native" }
        : input.environment === "wsl"
          ? {
              kind: "wsl",
              distribution: agent.distribution,
              env: agent.kind === "wsl" ? agent.env : undefined,
            }
          : agent
    return { client, project, agent, environment, source: runtime.source }
  }
  async snapshot(input: GitSettingsScope = {}): Promise<GitSettingsSnapshot> {
    const preferences = getGitPreferences()
    const desktopGit = await detection({ kind: "native" })
    const errors: string[] = []
    let context: Awaited<ReturnType<GitSettingsService["scope"]>>
    try {
      context = await this.scope(input)
    } catch (error) {
      return {
        preferences,
        desktopGit,
        agentGit: {
          environment: "native",
          available: false,
          error: `无法读取任务环境：${message(error)}`,
        },
        agentEnvironmentSource: "后台不可用",
        repository: false,
        identityEnvironment: input.environment ?? "native",
        globalIdentity:
          input.environment === "wsl"
            ? null
            : await identity("global", undefined, { kind: "native" }).catch(() => null),
        projectIdentity: null,
        worktrees: [],
        errors: [message(error)],
      }
    }
    const { project, environment, agent } = context
    const agentGit = await detection(agent)
    let repository = false
    if (project) {
      try {
        repository =
          (await git(["rev-parse", "--is-inside-work-tree"], project.path, environment)).trim() ===
          "true"
      } catch (error) {
        errors.push(`项目仓库不可用：${message(error)}`)
      }
    }
    const globalIdentity = await identity("global", undefined, environment).catch((error) => {
      errors.push(message(error))
      return null
    })
    const projectIdentity = repository
      ? await identity("project", project!.path, environment).catch((error) => {
          errors.push(message(error))
          return null
        })
      : null
    const worktrees = await this.worktrees().catch((error) => {
      errors.push(`独立目录状态不可用：${message(error)}`)
      return []
    })
    return {
      preferences,
      desktopGit,
      agentGit,
      agentEnvironmentSource: context.source,
      projectPath: project?.path,
      repository,
      identityEnvironment: environment.kind,
      globalIdentity,
      projectIdentity,
      worktrees,
      errors,
    }
  }
  async updatePreferences(input: { preferences: GitPreferences; expected: GitPreferences }) {
    if (input.preferences.worktreeRoot) {
      if (!isAbsolute(input.preferences.worktreeRoot)) throw new Error("独立目录必须是绝对路径。")
      const root = await realpath(input.preferences.worktreeRoot)
      if (!(await stat(root)).isDirectory()) throw new Error("独立目录不是有效文件夹。")
      const projects = await (await desktopSessionService.daemonClient()).projects.list()
      for (const project of projects) {
        if (isInsideGitDirectory(await realpath(project.path), root))
          throw new Error("独立目录不能位于项目内容目录中。")
      }
      input = { ...input, preferences: { ...input.preferences, worktreeRoot: root } }
    }
    const result = saveGitPreferences(input.preferences, input.expected)
    if (result.autoCleanup) void this.autoCleanup().catch(() => {})
    return result
  }
  updateIdentity(input: UpdateGitIdentityInput): Promise<GitSettingsSnapshot> {
    const operation = this.identitySave.then(() => this.saveIdentity(input))
    this.identitySave = operation.catch(() => {})
    return operation
  }
  private async saveIdentity(input: UpdateGitIdentityInput) {
    if (
      !input ||
      !["global", "project"].includes(input.scope) ||
      typeof input.name !== "string" ||
      typeof input.email !== "string" ||
      !input.name.trim() ||
      !/^[^\s@<>]+@[^\s@<>]+$/.test(input.email) ||
      /[\r\n\x00<>]/.test(input.name) ||
      input.name.length > 200 ||
      input.email.length > 320
    )
      throw new Error("请输入有效提交姓名和邮箱。")
    const { project, environment } =
      input.scope === "global" && input.environment === "native" && !input.projectId
        ? { project: undefined, environment: { kind: "native" as const } }
        : await this.scope(input)
    if (input.scope === "project" && !project) throw new Error("请明确选择要修改的项目。")
    const cwd = input.scope === "project" ? project!.path : undefined
    await saveIdentityAtomically(input, cwd, environment)
    return this.snapshot(input)
  }
  async uniqueBranch(path: string, name: string, environment: Environment = { kind: "native" }) {
    const prefix = getGitPreferences().branchPrefix
    const base = name.startsWith(prefix) ? name : `${prefix}${name}`
    await git(["check-ref-format", "--branch", base], path, environment)
    const existing = new Set(
      (await git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], path, environment))
        .trim()
        .split(/\r?\n/)
    )
    let branch = base
    for (let suffix = 2; existing.has(branch); suffix++) branch = `${base}-${suffix}`
    return branch
  }
  async createTaskWorktree(projectId: string, projectPath: string): Promise<GitWorktreeRecord> {
    const preferences = getGitPreferences()
    const id = randomUUID()
    const slug = `task-${id}`
    const { agent: environment, project } = await this.scope({ projectId })
    if (!project || (await realpath(project.path)) !== (await realpath(projectPath)))
      throw new Error("独立目录必须对应选定项目。")
    const branch = await this.uniqueBranch(projectPath, slug, environment)
    const configDir = preferences.worktreeRoot ?? app.getPath("userData")
    const baseCommit = (await git(["rev-parse", "HEAD"], projectPath, environment)).trim()
    const created = await createDesktopGitWorktree({
      cwd: projectPath,
      configDir,
      slug,
      branch,
      runGit: async (args, cwd) => {
        try {
          if (args[0] === "worktree" && args[1] === "add") {
            const destinationParent = resolve(args[4]!, "..")
            const actualProject = await realpath(projectPath)
            if (isInsideGitDirectory(actualProject, resolve(destinationParent)))
              throw new Error("独立工作目录不能位于项目内容目录中。")
            args = [...args.slice(0, 4), await gitPath(args[4]!, environment), ...args.slice(5)]
          }
          return { code: 0, stdout: await git(args, cwd, environment), stderr: "" }
        } catch (error) {
          return { code: 1, stdout: "", stderr: message(error) }
        }
      },
    })
    const record: GitWorktreeRecord = {
      id,
      projectId,
      projectPath,
      path: created.path,
      branch,
      configDir,
      slug,
      baseCommit,
      disposable: false,
      environment: environment.kind,
      distribution: environment.distribution,
    }
    try {
      updateGitWorktrees((items) => [...items, record])
    } catch (error) {
      await git(
        ["worktree", "remove", "--", await gitPath(created.path, environment)],
        projectPath,
        environment
      ).catch(() => {})
      throw error
    }
    return record
  }
  bindTaskWorktree(id: string, sessionId: string) {
    updateGitWorktrees((records) =>
      records.map((item) => (item.id === id ? { ...item, sessionId } : item))
    )
  }
  async discardUnboundWorktree(id: string) {
    const record = getGitSettings().worktrees.find((item) => item.id === id)
    if (!record || record.sessionId) throw new Error("只能撤销尚未绑定会话的目录。")
    const environment = recordEnvironment(record)
    if (
      (
        await git(["status", "--porcelain", "--untracked-files=all"], record.path, environment)
      ).trim() ||
      (await git(["rev-parse", "HEAD"], record.path, environment)).trim() !== record.baseCommit
    )
      throw new Error("创建失败后的目录已有成果，请保留并检查。")
    await git(
      ["worktree", "remove", "--", await gitPath(record.path, environment)],
      record.projectPath,
      environment
    )
    updateGitWorktrees((items) => items.filter((item) => item.id !== id))
  }
  async worktrees(): Promise<ManagedGitWorktree[]> {
    const client = await desktopSessionService.daemonClient()
    const sessions = await client.sessions.list({ includeArchived: true, limit: 10_000 })
    return Promise.all(
      getGitSettings().worktrees.map(async (record) => {
        const session = sessions.find((item) => item.id === record.sessionId)
        // A missing/idle session is not proof that its tasks have finished; inspect stored runs.
        let active = !record.sessionId
        let verified = false
        let dirty: boolean | null = null
        let preserved = false
        let bytes: number | null = null
        let reason = "目录状态尚未验证"
        let directoryRemoved = false
        try {
          const environment = recordEnvironment(record)
          directoryRemoved = await directoryMissing(record.path)
          const state = record.sessionId
            ? await client.sessions.getState(record.sessionId).catch((error) => {
                if (directoryRemoved && (error as { status?: number }).status === 404)
                  return undefined
                throw error
              })
            : undefined
          const snapshot = state
          active = snapshot
            ? snapshot.session.status !== "archived" ||
              snapshot.runs.some((run) => ["pending", "running"].includes(run.status)) ||
              (snapshot.tasks ?? []).some((task) => ["pending", "running"].includes(task.status))
            : !directoryRemoved
          if (directoryRemoved) {
            dirty = false
            bytes = 0
            verified = true
            preserved = typeof (record as GitCleanupRecord).directoryRemovedAt === "number"
            reason = active
              ? "目录已不存在，但会话尚未结束，暂不刷新绑定"
              : "目录已清理，会话绑定待刷新；重试只更新绑定"
          } else {
            if ((record as GitCleanupRecord).directoryRemovedAt)
              throw new Error("已清理的目录重新出现，无法确认归属，保留绑定")
            const root = await realpath(record.projectPath)
            const path = await realpath(record.path)
            if (isInsideGitDirectory(root, path)) throw new Error("目录位于项目内容中，禁止清理")
            const registered = await git(["worktree", "list", "--porcelain"], root, environment)
            const branch = (
              await git(["symbolic-ref", "--short", "HEAD"], path, environment)
            ).trim()
            const actualPath = await gitPath(path, environment)
            if (
              !registered
                .replace(/\\/g, "/")
                .includes(`worktree ${actualPath.replace(/\\/g, "/")}\n`) ||
              branch !== record.branch
            )
              throw new Error("工作目录或分支已改变，禁止清理")
            dirty =
              (
                await git(["status", "--porcelain", "--untracked-files=all"], path, environment)
              ).trim() !== ""
            const head = (await git(["rev-parse", "HEAD"], path, environment)).trim()
            const otherBranches = (
              await git(
                [
                  "for-each-ref",
                  `--contains=${head}`,
                  "--format=%(refname:short)",
                  "refs/heads",
                  "refs/remotes",
                ],
                root,
                environment
              )
            )
              .trim()
              .split(/\r?\n/)
              .filter((value) => value && value !== record.branch)
            preserved = head === record.baseCommit || otherBranches.length > 0
            bytes = await directoryBytes(path)
            verified = true
            reason = active
              ? "会话尚未归档或任务未结束；归档后才能清理"
              : dirty
                ? "包含未提交改动"
                : !preserved && !record.disposable
                  ? "成果尚未合并或明确允许删除"
                  : "可以安全清理"
          }
        } catch (error) {
          reason = message(error)
        }
        return {
          ...record,
          task: session?.title || record.sessionId,
          active,
          dirty,
          preserved,
          bytes,
          directoryRemoved,
          cleanupAllowed: directoryRemoved
            ? verified && !active
            : worktreeCleanupAllowed({
                active,
                dirty,
                preserved,
                disposable: record.disposable,
                verified,
              }),
          reason,
        }
      })
    )
  }
  async cleanup(input: { id: string }) {
    if (!input || typeof input.id !== "string" || this.cleaning.has(input.id))
      throw new Error("该目录正在清理或输入无效。")
    this.cleaning.add(input.id)
    let removed = false
    try {
      const item = (await this.worktrees()).find((entry) => entry.id === input.id)
      if (!item?.cleanupAllowed) throw new Error(item?.reason ?? "这不是 Vykor 管理的工作目录。")
      const record = getGitSettings().worktrees.find((record) => record.id === item.id)!
      removed = item.directoryRemoved === true
      const client = await desktopSessionService.daemonClient()
      if (
        record.sessionId &&
        ((await client.protocol.capabilities()).features.gitWorktreeBindings ?? 0) < 1
      )
        throw new Error("后台尚不支持已清理目录的会话绑定维护，请更新后台后重试。")
      const environment = recordEnvironment(record)
      const missing = await directoryMissing(record.path)
      if (item.directoryRemoved && !missing)
        throw new Error("目录重新出现，无法确认归属，不能刷新绑定。")
      removed = missing
      if (!removed) {
        await git(
          ["worktree", "remove", "--", await gitPath(item.path, environment)],
          item.projectPath,
          environment
        )
        removed = true
      }
      updateGitWorktrees((records) =>
        records.map((entry) =>
          entry.id === record.id
            ? {
                ...entry,
                directoryRemovedAt: (entry as GitCleanupRecord).directoryRemovedAt ?? Date.now(),
              }
            : entry
        )
      )
      if (record.sessionId) {
        try {
          const updated = await client.sessions.clearWorktreeBinding(record.sessionId, {
            id: record.id,
            path: record.path,
            branch: record.branch,
          })
          const desktop = updated?.metadata?.desktop as Record<string, unknown> | undefined
          if (!updated?.metadata || desktop?.worktree)
            throw new Error("后台没有确认已清除工作目录绑定。")
        } catch (error) {
          if ((error as { status?: number }).status !== 404) throw error
          // A missing archived session is already detached; distinguish it from an absent endpoint.
          let absent = false
          try {
            await client.sessions.get(record.sessionId)
          } catch (check) {
            if ((check as { status?: number }).status === 404) absent = true
            else throw check
          }
          if (!absent) throw error
        }
      }
      updateGitWorktrees((records) => records.filter((entry) => entry.id !== item.id))
    } catch (error) {
      if (removed)
        throw new Error(
          `目录已清理，但会话绑定或本机记录刷新失败；可重新读取后点击“刷新绑定”重试：${message(error)}`
        )
      throw error
    } finally {
      this.cleaning.delete(input.id)
    }
  }
  async markDisposable(input: { id: string; disposable: boolean }) {
    if (!input || typeof input.id !== "string" || typeof input.disposable !== "boolean")
      throw new Error("无效的目录标记。")
    const item = (await this.worktrees()).find((entry) => entry.id === input.id)
    if (!item || item.active || item.dirty !== false)
      throw new Error("只能标记已结束且无未提交改动的管理目录。")
    updateGitWorktrees((items) =>
      items.map((record) =>
        record.id === input.id ? { ...record, disposable: input.disposable } : record
      )
    )
  }
  async autoCleanup() {
    if (!getGitPreferences().autoCleanup) return
    for (const item of await this.worktrees())
      if (item.cleanupAllowed) await this.cleanup({ id: item.id }).catch(() => {})
  }
  async chooseDirectory() {
    const result = await dialog.showOpenDialog({
      title: "选择独立工作目录的专用位置",
      properties: ["openDirectory", "createDirectory"],
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  }
}
async function directoryBytes(path: string): Promise<number> {
  let bytes = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const child = resolve(path, entry.name)
    if (entry.isDirectory()) bytes += await directoryBytes(child)
    else if (entry.isFile()) bytes += (await stat(child)).size
  }
  return bytes
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
export const gitSettingsService = new GitSettingsService()

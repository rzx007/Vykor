import { mkdir, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildChildAgentWorktreeSlug, createChildAgentWorktreeManager } from "@openharness/agent-runtime";
import type { Settings } from "@openharness/core";
import type { ScheduledRunRecord, ScheduledTaskRecord } from "@openharness/protocol";
import type { SessionApplicationService } from "../session/session-application-service.js";

export interface ScheduledTaskExecutorOptions {
  sessions: Pick<SessionApplicationService, "getSession" | "createSession" | "admitPrompt" | "awaitRun">;
  outsideProjectWorkspaceRoot?: string;
  settings?: Settings;
  getSettings?: () => Settings;
  getSettingsForCwd?: (cwd: string) => Promise<Settings>;
}

/** Executes one claimed scheduled run; timer/claim ownership stays in ScheduledTaskService. */
export class ScheduledTaskExecutor {
  constructor(private readonly options: ScheduledTaskExecutorOptions) {}

  async execute(task: ScheduledTaskRecord, scheduledRun: ScheduledRunRecord) {
    const projectCwd = task.projectPaths[0];
    const outsideProject = task.destination === "standalone" && !projectCwd;
    let executionCwd: string | undefined;
    let worktree: Awaited<ReturnType<ReturnType<typeof createChildAgentWorktreeManager>["create"]>> & {
      manager: ReturnType<typeof createChildAgentWorktreeManager>;
    } | undefined;
    let session: ReturnType<ScheduledTaskExecutorOptions["sessions"]["getSession"]>;
    try {
      executionCwd = outsideProject
        ? await allocateWorkspace(this.options.outsideProjectWorkspaceRoot, scheduledRun.id)
        : projectCwd;
      if (task.executionMode === "worktree") {
      if (!projectCwd) throw new Error("Worktree scheduled execution requires user attention: project is unavailable");
      const manager = createChildAgentWorktreeManager({ cwd: projectCwd });
      if (!(await manager.isGitRepo())) throw new Error("Worktree scheduled execution requires user attention: project is not a Git repository");
      const slug = buildChildAgentWorktreeSlug({ team: "scheduled", agent: task.id, nonce: scheduledRun.id.slice(0, 8) });
      const created = await manager.create(slug).catch((error) => {
        throw new Error(`Worktree scheduled execution requires user attention: ${error instanceof Error ? error.message : String(error)}`);
      });
      worktree = { manager, ...created };
      executionCwd = created.path;
      }
      session = task.sessionId ? this.options.sessions.getSession(task.sessionId) : undefined;
      if (task.destination === "chat") {
        if (!session) throw new Error(`Scheduled task chat is unavailable: ${task.sessionId}`);
        if (session.status === "archived") throw new Error("Scheduled task chat is archived and requires user attention");
      } else {
        if (!executionCwd) throw new Error("Scheduled task project is unavailable");
        const settings = (await this.options.getSettingsForCwd?.(projectCwd ?? executionCwd)) ?? this.options.getSettings?.() ?? this.options.settings;
        const model = task.model ?? settings?.model;
        if (!model) throw new Error("Scheduled task model is unavailable");
        const deniedTools = new Set(task.permissionProfile.deniedTools ?? []);
        if (task.permissionProfile.network === false) { deniedTools.add("WebFetch"); deniedTools.add("WebSearch"); }
        session = this.options.sessions.createSession({
          cwd: executionCwd, title: `${task.name} · scheduled run`, model,
          metadata: {
            ...(outsideProject ? { desktop: { workspaceMode: "outside_project" } } : {}),
            runtime: {
              model, permissionMode: permissionMode(task.permissionProfile.mode),
              ...(isEffort(task.effort) ? { effort: task.effort } : {}),
              ...(task.permissionProfile.allowedTools?.length ? { allowedTools: task.permissionProfile.allowedTools } : {}),
              ...(deniedTools.size ? { disallowedTools: [...deniedTools] } : {}),
            },
            scheduledTask: {
              taskId: task.id, scheduledRunId: scheduledRun.id, destination: task.destination, executionMode: task.executionMode,
              ...(worktree ? { worktree: { path: worktree.path, branch: worktree.branch } } : {}),
            },
          },
        });
      }
      const admission = await this.options.sessions.admitPrompt(session!.id, {
        id: `scheduled-input:${scheduledRun.id}`,
        items: [{ type: "text", text: scheduledPrompt(task) }], delivery: "queue",
        metadata: { source: "scheduled_task", scheduledTaskId: task.id, scheduledRunId: scheduledRun.id, scheduledFor: scheduledRun.scheduledFor },
        runMetadata: { source: "scheduled_task", scheduledTaskId: task.id, scheduledRunId: scheduledRun.id },
      });
      if (!admission.run) throw new Error("Scheduled task Agent runtime is unavailable");
      const result = await this.options.sessions.awaitRun(session!.id, admission.run.id);
      if (result.status !== "completed") throw new Error(result.error ?? `Scheduled Agent run ${result.status}`);
      return { sessionId: session!.id, runId: admission.run.id, summary: result.output.slice(0, 20_000) };
    } finally {
      if (outsideProject && !session && executionCwd) await rmdir(executionCwd).catch(() => {});
      if (worktree?.created && !(await worktree.manager.hasChanges(worktree.slug).catch(() => true))) {
        await worktree.manager.remove(worktree.slug).catch(() => {});
      }
    }
  }
}

async function allocateWorkspace(root: string | undefined, runId: string): Promise<string> {
  const now = new Date();
  const day = [String(now.getFullYear()).padStart(4, "0"), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
  const workspace = join(root ?? join(homedir(), "Documents", "OpenHarness"), day, `scheduled-${runId}`);
  await mkdir(workspace, { recursive: true });
  return workspace;
}

function permissionMode(mode: "read_only" | "workspace_write" | "full_access") {
  return mode === "read_only" ? "plan" as const : mode === "full_access" ? "full_auto" as const : "default" as const;
}

function isEffort(value: string | undefined): value is "low" | "medium" | "high" {
  return value === "low" || value === "medium" || value === "high";
}

function scheduledPrompt(task: Pick<ScheduledTaskRecord, "prompt" | "skillNames" | "pluginNames">): string {
  const context = [
    ...(task.skillNames.length ? [`Use these task skills when applicable: ${task.skillNames.join(", ")}.`] : []),
    ...(task.pluginNames.length ? [`Use these connected plugins when applicable: ${task.pluginNames.join(", ")}.`] : []),
  ];
  return context.length ? `${task.prompt}\n\n${context.join("\n")}` : task.prompt;
}

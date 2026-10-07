import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { getDataDir, getLogsDir } from "@vykor/core";
import type { SessionStore } from "@vykor/services";
import type { SessionCommandService } from "../session/session-command-service.js";
import type { DaemonControlService } from "../control/daemon-control-service.js";
import type { DaemonTerminalService } from "../../terminal/daemon-terminal-service.js";

import type { CleanupPreview, CleanupResult } from "@vykor/protocol";
export type { CleanupCandidate, CleanupPreview, CleanupResult } from "@vykor/protocol";
export class MaintenanceCleanupService {
  private previews = new Map<string, CleanupPreview>();
  constructor(private store: SessionStore, private control: DaemonControlService, private commands: SessionCommandService, private terminals?: Pick<DaemonTerminalService, "list">) {}
  preview(input: { kind: "session" | "log"; olderThan: number }): CleanupPreview {
    if (!["session", "log"].includes(input.kind) || !Number.isFinite(input.olderThan) || input.olderThan < 0 || input.olderThan > Date.now()) throw new Error("清理类型或时间范围无效");
    const result: CleanupPreview = { id: randomUUID(), createdAt: Date.now(), olderThan: input.olderThan, candidates: [], protected: [], bytes: 0, scope: input.kind === "session" ? "删除所选根会话及子会话；附件引用随既有删除流程释放，物理文件由附件清理另行处理。数据库文件不会因此立即缩小。" : `只删除 ${getLogsDir()} 中已轮转、早于指定时间的日志；当前 daemon.log 和非轮转文件保护。` };
    if (input.kind === "session") {
      const sessions = this.store.sessions.list({ includeArchived: true });
      for (const session of sessions.filter(session => !session.parentId && session.updatedAt < input.olderThan)) {
        const tree = this.tree(session.id);
        const reason = this.protection(tree);
        if (reason) { result.protected.push({ id: session.id, reason }); continue; }
        result.candidates.push({ id: session.id, kind: "session", label: session.title, updatedAt: session.updatedAt, bytes: 0, children: tree.length - 1, attachments: tree.reduce((count, id) => count + this.store.conversations.listSessionInputAttachments(id).length, 0) });
      }
    } else if (existsSync(getLogsDir())) {
      const root = getLogsDir();
      if (lstatSync(root).isSymbolicLink()) throw new Error("日志目录为链接，拒绝清理");
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (!entry.isFile() || !/\.(?:log|jsonl|ndjson)[.-](?:\d[\w.-]*)$/.test(entry.name)) { result.protected.push({ id: entry.name, reason: "正在使用的日志、非轮转文件或链接" }); continue; }
        const stat = lstatSync(path);
        if (stat.mtimeMs < input.olderThan) result.candidates.push({ id: entry.name, kind: "log", label: entry.name, updatedAt: stat.mtimeMs, bytes: stat.size });
      }
    }
    result.bytes = result.candidates.reduce((sum, item) => sum + item.bytes, 0);
    for (const [id, preview] of this.previews) if (Date.now() - preview.createdAt > 600_000) this.previews.delete(id);
    this.previews.set(result.id, result);
    return result;
  }
  async execute(input: { previewId: string; ids: string[] }): Promise<CleanupResult> {
    const preview = this.previews.get(input.previewId);
    if (!preview || Date.now() - preview.createdAt > 600_000) throw new Error("清理预览已过期，请重新扫描");
    if (!Array.isArray(input.ids) || !input.ids.length || input.ids.some(id => typeof id !== "string" || !preview.candidates.some(item => item.id === id))) throw new Error("清理对象不在预览中");
    this.previews.delete(input.previewId);
    const result: CleanupResult = { auditId: randomUUID(), completed: [], skipped: [], failures: [], releasedBytes: 0 };
    const selected = preview.candidates.filter(item => input.ids.includes(item.id));
    const directory = join(getDataDir(), "maintenance-audits"); mkdirSync(directory, { recursive: true });
    const auditPath = join(directory, `${result.auditId}.json`);
    const audit = { version: 1, createdAt: Date.now(), previewId: preview.id, planned: selected.map(item => ({ id: item.id, kind: item.kind })), state: "running", result };
    const saveAudit = () => { writeFileSync(`${auditPath}.tmp`, JSON.stringify(audit, null, 2), { mode: 0o600 }); renameSync(`${auditPath}.tmp`, auditPath); };
    saveAudit();
    for (const candidate of selected) {
      try {
        if (candidate.kind === "session") {
          const tree = this.tree(candidate.id);
          if (this.terminals && (await this.terminals.list()).some(terminal => terminal.sessionId && tree.includes(terminal.sessionId) && (terminal.status === "running" || terminal.status === "stopping"))) { result.skipped.push({ id: candidate.id, reason: "包含仍打开的会话终端" }); continue; }
          const session = this.store.sessions.get(candidate.id);
          if (!session || session.updatedAt !== candidate.updatedAt) { result.skipped.push({ id: candidate.id, reason: "会话已改变或不存在" }); continue; }
          const reason = this.protection(this.tree(candidate.id));
          if (reason) { result.skipped.push({ id: candidate.id, reason }); continue; }
          // No await between the latest guard and the shared command's synchronous barrier acquisition.
          await this.commands.deleteSessionTree(candidate.id);
        } else {
          const root = getLogsDir(); const path = join(root, candidate.id);
          if (basename(candidate.id) !== candidate.id || lstatSync(root).isSymbolicLink()) throw new Error("日志路径无效");
          const relativePath = relative(realpathSync(root), realpathSync(path));
          if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error("日志不在实际目录内");
          const stat = lstatSync(path);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== candidate.bytes || stat.mtimeMs !== candidate.updatedAt) { result.skipped.push({ id: candidate.id, reason: "文件正在写入或已变化" }); continue; }
          unlinkSync(path); result.releasedBytes += stat.size;
        }
        result.completed.push(candidate.id);
      } catch (error) { result.failures.push({ id: candidate.id, reason: error instanceof Error ? error.message : String(error) }); }
      saveAudit();
    }
    audit.state = "finished"; saveAudit();
    return result;
  }
  audits() {
    const directory = join(getDataDir(), "maintenance-audits");
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter(name => /^[\w-]+\.json$/.test(name)).map(name => JSON.parse(readFileSync(join(directory, name), "utf-8")) as Record<string, unknown>).sort((a, b) => Number(b.createdAt) - Number(a.createdAt)).slice(0, 50);
  }
  private tree(id: string): string[] { return [id, ...this.store.sessions.listChildren(id, { includeArchived: true }).flatMap(child => this.tree(child.id))]; }
  private protection(ids: string[]): string | null {
    if (ids.some(id => {
      const desktop = this.store.sessions.get(id)?.metadata?.desktop as Record<string, unknown> | undefined;
      if (!desktop?.worktree) return false;
      const path = (desktop.worktree as Record<string, unknown>).path;
      if (typeof path !== "string" || !isAbsolute(path)) return true;
      try { statSync(path); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
    })) return "仍绑定独立工作目录；请先在 Git 设置中安全清理独立工作目录";
    if (this.control.hasAnyActiveRuns() || this.control.runtimeSnapshot().coordinator.queuedRunCount > 0) return "后台仍有活动或排队任务，请收尾后重试";
    if (ids.some(id => this.store.runs.listRuns(id).some(run => run.status === "pending" || run.status === "running"))) return "包含活动或排队运行记录";
    if (ids.some(id => this.store.listSessionTasks(id).some(task => task.status === "pending" || task.status === "running"))) return "包含活动子任务或后台任务";
    if (this.store.permissions.list().some(permission => ids.includes(permission.sessionId) && permission.status === "pending")) return "仍有待批准操作";
    if (this.store.listProjectionSettlements().some(row => ids.includes(row.rootSessionId) && (row.status === "pending" || row.status === "retrying"))) return "仍有待收束的数据记录";
    if (this.store.workflows?.listRuns().some(row => row.ownerSessionId && ids.includes(row.ownerSessionId) && row.status === "running")) return "仍有活动工作流";
    return null;
  }
}

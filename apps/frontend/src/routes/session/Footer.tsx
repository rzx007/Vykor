import { useEffect, useState } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useTheme } from "../../theme/ThemeContext";
import { parseStatus } from "../../services/status";
import { CWD_DISPLAY_MAX_LEN, TOKEN_K_THRESHOLD } from "../../ui/constants";
import type { McpServerSnapshot } from "../../types";

/** Read current git branch from .git/HEAD. Returns branch name or null. */
function readGitBranch(): string | null {
  try {
    const headPath = join(process.cwd(), ".git", "HEAD");
    const content = readFileSync(headPath, "utf8").trim();
    const match = content.match(/^ref: refs\/heads\/(.+)$/);
    return match ? (match[1] ?? null) : null;
  } catch {
    return null;
  }
}

const BRANCH_POLL_MS = 10_000;

/** 低频轮询 .git/HEAD：会话中切分支后 Footer 跟着刷新（同值 setState 会被 React 跳过） */
function useGitBranch(): string | null {
  const [branch, setBranch] = useState<string | null>(() => readGitBranch());
  useEffect(() => {
    const id = setInterval(() => {
      setBranch(readGitBranch());
    }, BRANCH_POLL_MS);
    return () => clearInterval(id);
  }, []);
  return branch;
}

function formatTokens(n: number): string {
  if (n >= TOKEN_K_THRESHOLD) return `${(n / TOKEN_K_THRESHOLD).toFixed(1)}k`;
  return String(n);
}

function truncateCwd(cwd: string, maxLen = CWD_DISPLAY_MAX_LEN): string {
  // home 目录前缀缩写为 ~（对齐 opencode 的 "~\Desktop" 风格）
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  if (home && cwd.startsWith(home)) {
    cwd = "~" + cwd.slice(home.length);
  }
  if (cwd.length <= maxLen) return cwd;
  return "…" + cwd.slice(cwd.length - (maxLen - 1));
}

export type FooterProps = {
  status: Record<string, unknown>;
  mcpServers: McpServerSnapshot[];
  version?: string | null;
};

export function Footer({ status, mcpServers, version }: FooterProps) {
  const { theme } = useTheme();
  const c = theme.colors;
  const gitBranch = useGitBranch();

  const { inputTokens, outputTokens } = parseStatus(status);
  const isPlan = status.work_mode === "plan"
    || (status.work_mode == null && status.permission_mode === "plan");
  const isCoordinator = status.session_mode === "coordinator";
  const hasTokens = inputTokens > 0 || outputTokens > 0;

  const mcpCount = mcpServers.length;
  const allConnected =
    mcpCount > 0 &&
    mcpServers.every(
      (s) => s.state === "connected" || s.state === "ok",
    );
  const hasError = mcpServers.some(
    (s) => s.state === "error" || s.state === "failed",
  );
  const mcpColor = hasError ? c.error : allConnected ? c.success : c.muted;

  const cwd = truncateCwd(process.cwd());
  const branchSuffix = gitBranch ? `:${gitBranch}` : "";
  const leftLabel = cwd + branchSuffix;

  return (
    <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
      {/* Left: cwd:branch ⊙N MCP /status（对齐 opencode 左侧信息区） */}
      <text fg={c.muted}>
        {leftLabel}
        {isPlan ? <span fg={c.warning}>{" [PLAN]"}</span> : null}
        {isCoordinator ? <span fg={c.accent}>{" [COORDINATOR]"}</span> : null}
        {mcpCount > 0 ? <span fg={mcpColor}>{`  ⊙ ${mcpCount} MCP`}</span> : null}
        <span fg={c.muted}>{"  /status"}</span>
      </text>

      {/* Right: tokens · version */}
      <text fg={c.muted}>
        {hasTokens ? (
          <span fg={c.muted}>{`${formatTokens(inputTokens)}↓ ${formatTokens(outputTokens)}↑`}</span>
        ) : null}
        {hasTokens && version ? <span fg={c.muted}>{" · "}</span> : null}
        {version ? <span fg={c.muted}>{version}</span> : null}
      </text>
    </box>
  );
}

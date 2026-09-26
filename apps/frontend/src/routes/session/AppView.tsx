import { useTheme } from "../../theme/ThemeContext";
import { Home } from "../Home";
import { Session } from "./Session";
import { Sidebar } from "./Sidebar";
import { Footer } from "./Footer";
import { Prompt } from "../../components/prompt/Prompt";
import type { McpServerSnapshot, TranscriptItem } from "../../types";
import type { Command } from "../../keymap/commands";
import type { SessionModelRetryState, SessionModelUsageSummary } from "@vykor/client";
import { parseStatus } from "../../services/status";

export type AppViewProps = {
  transcript: TranscriptItem[];
  assistantBuffer: string;
  retry?: SessionModelRetryState;
  usage?: SessionModelUsageSummary;
  knownUsage?: { inputTokens: number; outputTokens: number };
  ready: boolean;
  busy: boolean;
  status: Record<string, unknown>;
  mcpServers: McpServerSnapshot[];
  version?: string | null;
  history: string[];
  slashCommands: Command[];
  onSubmit: (line: string) => void;
  onCycleMode: () => void;
  dialogOpen: boolean;
  /** 草稿提升：dialogOpen 卸载 Prompt 时由 AppInner 持有，重挂载恢复 */
  draft?: string;
  onDraftChange?: (text: string) => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  escHint?: boolean;
};

/**
 * 纯渲染层（无副作用、易测）。根据会话状态在三种布局间切换：
 * 未就绪占位 / Home 路由（无对话时）/ Session 路由（左栏消息流 + 右栏 Sidebar）。
 */
export function AppView({
  transcript,
  assistantBuffer,
  retry,
  usage,
  knownUsage,
  ready,
  busy,
  status,
  mcpServers,
  version,
  history,
  slashCommands,
  onSubmit,
  onCycleMode,
  dialogOpen,
  draft,
  onDraftChange,
  sidebarOpen,
  onToggleSidebar: _onToggleSidebar,
  escHint,
}: AppViewProps) {
  const { theme } = useTheme();

  if (!ready) {
    return (
      <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.colors.background}>
        <text fg={theme.colors.warning}>Connecting to backend...</text>
      </box>
    );
  }

  // Route: Home if no user/assistant items yet and not busy and no streaming
  const hasConversation = transcript.some(
    (item) => item.role === "user" || item.role === "assistant",
  );
  const isHome = !hasConversation && !busy && !assistantBuffer;

  const { mode, model, effort } = parseStatus(status);

  const prompt = dialogOpen ? null : (
    <Prompt
      busy={busy}
      mode={mode}
      model={model}
      effort={effort}
      history={history}
      slashCommands={slashCommands}
      onSubmit={onSubmit}
      onCycleMode={onCycleMode}
      draft={draft}
      onDraftChange={onDraftChange}
      escHint={escHint}
    />
  );

  if (isHome) {
    return (
      <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.colors.background}>
        <Home>{prompt}</Home>
        <Footer status={status} mcpServers={mcpServers} version={version} />
      </box>
    );
  }

  return (
    <box flexDirection="row" width="100%" height="100%" backgroundColor={theme.colors.background}>
      {/* Left column: messages + panels + prompt + footer */}
      <box flexDirection="column" flexGrow={1} backgroundColor={theme.colors.background}>
        <Session items={transcript} assistantBuffer={assistantBuffer} retry={retry} usage={usage} inputTokens={knownUsage?.inputTokens} outputTokens={knownUsage?.outputTokens} />
        {prompt}
        <Footer status={status} mcpServers={mcpServers} version={version} />
      </box>
      {/* Right column: Sidebar */}
      {sidebarOpen ? (
        <Sidebar
          status={status}
          transcript={transcript}
          mcpServers={mcpServers}
          version={version}
        />
      ) : null}
    </box>
  );
}

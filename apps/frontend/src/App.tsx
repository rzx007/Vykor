import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useServerSync } from "./hooks/useServerSync";
import { useEscToCancel } from "./hooks/useEscToCancel";
import { useModalWiring } from "./hooks/useModalWiring";
import { ThemeProvider, useTheme } from "./theme/ThemeContext";
import { DialogProvider, useDialog } from "./ui/DialogContext";
import { ToastProvider, useToast } from "./ui/Toast";
import { DialogSelect } from "./ui/DialogSelect";
import { ModelPickerDialog } from "./ui/ModelPickerDialog";
import { buildRegistry, type CommandRegistry } from "./keymap/commands";
import { PERMISSION_MODES, PERMISSION_MODE_ORDER } from "./keymap/permissionModes";
import { HISTORY_LIMIT, SIDEBAR_AUTO_OPEN_WIDTH } from "./ui/constants";
import { BUILTIN_THEMES } from "./theme/builtinThemes";
import { AppView } from "./routes/session/AppView";
import { JobsPanel, type JobsPanelProps } from "./components/JobsPanel";
import type { FrontendConfig } from "./types";
import type { TuiAction } from "./hooks/sessionController";
import { copySelectionToClipboard } from "./utils/selection";

type JobsPanelCallbacks = Omit<JobsPanelProps, "state" | "detailState">;

export function createJobsPanelCallbacks(sendRequest: (action: TuiAction) => void): JobsPanelCallbacks {
  return {
    onRefresh: () => sendRequest({ type: "job_request", job_action: "refresh" }),
    onSelect: (jobId) => sendRequest({ type: "job_request", job_action: "select", job_id: jobId }),
    onCancel: (jobId) => sendRequest({
      type: "job_request",
      job_action: "cancel",
      job_id: jobId,
      reason: "Cancelled from TUI",
    }),
  };
}

export function shouldOpenJobsPanel(line: string): boolean {
  return ["/jobs", "/workflow", "/workflows"].includes(line.trim());
}

// ─────────── AppInner — session + dialog wiring ─────────────

function AppInner({ config }: { config: FrontendConfig }) {
  const renderer = useRenderer();
  const { width: terminalWidth } = useTerminalDimensions();
  const [sidebarOpen, setSidebarOpen] = useState(() => terminalWidth >= SIDEBAR_AUTO_OPEN_WIDTH);
  const [jobsPanelOpen, setJobsPanelOpen] = useState(false);
  const dialog = useDialog();
  const { setThemeName, theme } = useTheme();
  const { toast } = useToast();

  // 主题切换时同步 renderer 底色（含 OSC 11，避免透出终端背景）
  useEffect(() => {
    renderer.setBackgroundColor(theme.colors.background);
  }, [renderer, theme.colors.background]);

  const onSessionExit = useCallback((code?: number | null) => {
    process.exitCode = code ?? 0;
    renderer.destroy();
  }, [renderer],);
  const onSessionError = useCallback((message: string) => toast(message, "error"), [toast]);
  const session = useServerSync(config, onSessionError);
  const jobsPanelCallbacks = useMemo(() => createJobsPanelCallbacks(session.sendRequest), [session.sendRequest]);
  const activeSessionId = typeof session.status.session_id === "string"
    ? session.status.session_id
    : undefined;
  const previousSessionIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const previousSessionId = previousSessionIdRef.current;
    if (previousSessionId && previousSessionId !== activeSessionId) {
      dialog.closeAll();
      setJobsPanelOpen(false);
      setDraft("");
    }
    previousSessionIdRef.current = activeSessionId;
  }, [activeSessionId, dialog.closeAll]);

  // Local input history (up to 100 entries)
  const [history, setHistory] = useState<string[]>([]);

  // Prompt 草稿：dialog 打开会卸载 Prompt，提升到这里保证弹层关闭后草稿不丢
  const [draft, setDraft] = useState("");

  // 双击 Esc 取消运行中的对话
  const { escHint, handleEscape } = useEscToCancel(session.busy, () => {
    session.sendRequest({ type: "interrupt" });
  });

  const appendHistory = useCallback((line: string) => {
    setHistory((prev) => {
      const next = [...prev, line];
      return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
    });
  }, []);

  const setPermissionMode = useCallback(
    (mode: "default" | "plan" | "full_auto") => {
      session.sendRequest({ type: "set_permission_mode", permission_mode: mode, });
    },
    [session],
  );

  const openModelPicker = useCallback(() => {
    const currentModel = typeof session.status.model === "string"
      ? session.status.model
      : ( config.daemon?.model ?? undefined);

    dialog.replace(
      <box flexDirection="column">
        <text>Loading models...</text>
      </box>,
    );

    void session.loadModels()
      .then((providers) => {
        dialog.replace(
          <ModelPickerDialog
            providers={providers}
            currentModel={currentModel}
            onSelect={(model) => {
              session.sendRequest({
                type: "select_model",
                model: model.id,
                provider: model.providerName,
              });
              dialog.close();
              toast(`Model: ${model.id}`);
            }}
          />,
        );
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        dialog.close();
        toast(`Models: ${message}`, "error");
      });
  }, [config.daemon?.model, dialog, session, toast]);

  // ──────────── handleCommand: intercept special slash commands ───────────────
  const handleCommand = useCallback(
    (line: string): boolean => {
      // /theme set X
      const themeSetMatch = line.match(/^\/theme\s+set\s+(\S+)$/);
      if (themeSetMatch?.[1]) {
        setThemeName(themeSetMatch[1]);
        toast(`Theme: ${themeSetMatch[1]}`);
        return true;
      }

      // /theme (no args) — open theme picker
      if (line.trim() === "/theme") {
        const themeKeys = Object.keys(BUILTIN_THEMES);
        const currentTheme = theme.name;
        dialog.replace(
          <DialogSelect
            title="Select Theme"
            items={themeKeys.map((k) => ({
              value: k,
              label: k,
              active: k === currentTheme,
            }))}
            onSelect={(value) => {
              setThemeName(value);
              toast(`Theme: ${value}`);
              dialog.close();
            }}
          />,
        );
        return true;
      }

      if (line.trim() === "/models") {
        openModelPicker();
        return true;
      }

      // /permissions or /permissions show — open permissions picker
      if (line.trim() === "/permissions" || line.trim() === "/permissions show") {
        const currentMode = String(session.status.permission_mode ?? "default");
        const currentIndex = PERMISSION_MODES.findIndex((m) => m.value === currentMode);
        dialog.replace(
          <DialogSelect
            title="Permission Mode"
            items={PERMISSION_MODES.map((m) => ({
              value: m.value,
              label: m.label,
              description: m.description,
              active: m.value === currentMode,
            }))}
            onSelect={(value) => {
              setPermissionMode(value as "default" | "plan" | "full_auto");
              dialog.close();
            }}
            searchable={false}
            initialIndex={currentIndex >= 0 ? currentIndex : 0}
          />,
        );
        return true;
      }

      // /plan — toggle plan mode
      if (line.trim() === "/plan") {
        const currentMode = String(session.status.permission_mode ?? "default");
        const isPlan = currentMode === "plan";
        session.sendRequest({
          type: "submit_line",
          line: isPlan ? "/plan off" : "/plan on",
        });
        return true;
      }

      const coordinatorMatch = line.trim().match(/^\/coordinator(?:\s+(on|off|status))?$/);
      if (coordinatorMatch) {
        const currentMode = String(session.status.session_mode ?? "direct");
        const action = coordinatorMatch[1] ?? (currentMode === "coordinator" ? "off" : "on");
        if (action === "status") {
          toast(`Coordinator mode: ${currentMode === "coordinator" ? "on" : "off"}`);
          return true;
        }
        if (activeSessionId) {
          toast("Use /new before changing coordinator mode", "error");
          return true;
        }
        session.sendRequest({
          type: "set_session_mode",
          session_mode: action === "on" ? "coordinator" : "direct",
        });
        toast(`Coordinator mode: ${action}`);
        return true;
      }

      // /sessions — 列出并切换会话；/resume 专用于显式重放中断 run。
      if (line.trim() === "/sessions") {
        session.sendRequest({ type: "list_sessions" });
        return true;
      }

      if (shouldOpenJobsPanel(line)) {
        setJobsPanelOpen(true);
        session.sendRequest({ type: "job_request", job_action: "open" });
        return true;
      }

      return false;
    },
    [activeSessionId, dialog, openModelPicker, session, setThemeName, theme.name, toast],
  );

  // ─────────────────────── openCommandPalette helper ───────────────────────────
  // 复用下方 useMemo 的注册表（经 ref 解循环依赖：registry.local 里的
  // app.palette.run 也要能打开面板）。
  const registryRef = useRef<CommandRegistry | null>(null);
  const openCommandPalette = useCallback(() => {
    const registry = registryRef.current;
    if (!registry) return;
    const allCmds = registry.all();
    dialog.replace(
      <DialogSelect
        title="Commands"
        items={allCmds.map((cmd) => ({
          value: cmd.id,
          label: cmd.id,
          description: cmd.title !== cmd.id ? cmd.title : undefined,
          hint: cmd.keybinding,
        }))}
        onSelect={(id) => {
          dialog.close();
          const cmd = registry.get(id);
          cmd?.run();
        }}
      />,
    );
  }, [dialog]);

  // ─────────────────────────────── onSubmit ────────────────────────────────────
  const onSubmit = useCallback(
    (line: string) => {
      if (handleCommand(line)) {
        appendHistory(line);
        return;
      }
      session.sendRequest({ type: "submit_line", line });
      appendHistory(line);
    },
    [appendHistory, handleCommand, session],
  );

  // ────────────────────────────────── onCycleMode ──────────────────────────────
  const onCycleMode = useCallback(() => {
    const currentMode = String(session.status.permission_mode ?? "default");
    const idx = PERMISSION_MODE_ORDER.indexOf(currentMode);
    const nextMode = PERMISSION_MODE_ORDER[(idx + 1) % PERMISSION_MODE_ORDER.length] ?? "default";
    setPermissionMode(nextMode as "default" | "plan" | "full_auto");
  }, [session.status.permission_mode, setPermissionMode]);

  // ──────────────── Command registry for slashCommands prop ────────────────────
  const registry = useMemo(
    () =>
      buildRegistry({
        // 优先用带描述的 command_details（补全/面板展示描述），旧后端回退纯名称；按名称排序对齐 opencode
        backendCommands: (session.commandDetails.length > 0 ? [...session.commandDetails] : session.commands.map((name) => ({ name }))).sort((a, b) => a.name.localeCompare(b.name)),
        local: [
          {
            id: "app.palette",
            title: "Open Command Palette",
            keybinding: "ctrl+p",
            run: openCommandPalette,
          },
          {
            // 必须用斜杠 id 覆盖后端 LOCAL 同名命令；否则补全回车走 submitLine → local_ui 被忽略，弹框不会开。
            id: "/theme",
            title: "Change Theme",
            run: () => handleCommand("/theme"),
          },
          {
            id: "/permissions",
            title: "Change Permission Mode",
            run: () => handleCommand("/permissions"),
          },
          {
            id: "/models",
            title: "Select Model",
            run: () => handleCommand("/models"),
          },
          {
            id: "/coordinator",
            title: "Toggle Coordinator Mode",
            run: () => handleCommand("/coordinator"),
          },
          {
            id: "/sessions",
            title: "List & restore sessions",
            run: () => handleCommand("/sessions"),
          },
          {
            id: "app.sidebar",
            title: "Toggle Sidebar",
            run: () => setSidebarOpen((v) => !v),
          },
          {
            id: "app.jobs",
            title: "Jobs",
            run: () => {
              setJobsPanelOpen(true);
              session.sendRequest({ type: "job_request", job_action: "open" });
            },
          },
          {
            id: "/jobs",
            title: "Open Jobs panel",
            run: () => handleCommand("/jobs"),
          },
          {
            id: "/workflow",
            title: "Open Jobs panel",
            run: () => handleCommand("/workflow"),
          },
          {
            id: "/workflows",
            title: "Open Jobs panel",
            run: () => handleCommand("/workflows"),
          },
          {
            id: "app.exit",
            title: "Exit",
            keybinding: "ctrl+c",
            run: () => onSessionExit(0),
          },
        ],
        submitLine: (line: string) => {
          session.sendRequest({ type: "submit_line", line });
        },
      }),
    [handleCommand, onSessionExit, openCommandPalette, session],
  );
  registryRef.current = registry;

  // ──────────── Dialog wiring for backend modal/select requests ────────────────
  useModalWiring(session, dialog);

  // ──────────────────────── Global keyboard handler ────────────────────────────
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      if (copySelectionToClipboard(renderer, toast)) {
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      key.preventDefault();
      key.stopPropagation();
      onSessionExit(0);
    }
    if (key.ctrl && key.name === "p") {
      // 已有弹层（含后端 permission/question/select）时不顶掉：
      // dialog.replace 会触发被顶层的 onClose（permission 会被当作拒绝）。
      if (dialog.isOpen) return;
      openCommandPalette();
    }
    if (key.name === "escape" && jobsPanelOpen) {
      setJobsPanelOpen(false);
      return;
    }
    if (key.ctrl && key.name === "b") {
      setSidebarOpen((v) => !v);
    }
    if (key.name === "escape" && session.busy && !dialog.isOpen) {
      handleEscape();
    }
  });

  const jobsPanelWidth = Math.min(78, Math.max(54, Math.floor(terminalWidth * 0.7)));
  const jobsPanelLeft = Math.max(0, Math.floor((terminalWidth - jobsPanelWidth) / 2));

  return (
    <>
      <AppView
        transcript={session.transcript}
        assistantBuffer={session.assistantBuffer}
        retry={session.retry}
        usage={session.usage}
        knownUsage={session.knownUsage}
        ready={session.ready}
        busy={session.busy}
        status={session.status}
        mcpServers={session.mcpServers}
        version={config.version ?? null}
        history={history}
        slashCommands={registry.slashCommands()}
        onSubmit={onSubmit}
        onCycleMode={onCycleMode}
        dialogOpen={dialog.isOpen || jobsPanelOpen}
        draft={draft}
        onDraftChange={setDraft}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        escHint={escHint}
      />
      {jobsPanelOpen ? (
        <box position="absolute" top={2} left={jobsPanelLeft} width={jobsPanelWidth} zIndex={90} border={true} borderColor={theme.colors.accent} backgroundColor={theme.colors.backgroundPanel} padding={1} flexDirection="column">
          <JobsPanel
            state={session.jobState}
            detailState={session.jobDetailState}
            {...jobsPanelCallbacks}
          />
        </box>
      ) : null}
    </>
  );
}

// ───────────────────────── App — root with providers ─────────────────────────

export function App({ config }: { config: FrontendConfig }) {
  const initialTheme = String(config.theme ?? "default");
  return (
    <ThemeProvider initialTheme={initialTheme}>
      <DialogProvider>
        <ToastProvider>
          <AppInner config={config} />
        </ToastProvider>
      </DialogProvider>
    </ThemeProvider>
  );
}

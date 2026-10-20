import { normalizeApprovalMode } from "@vykor/client";
import { useState, useEffect, useRef, useCallback } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes, decodePasteBytes, stripAnsiSequences } from "@opentui/core";
import type { PasteEvent, TextareaRenderable } from "@opentui/core";
import { useTheme } from "../../theme/ThemeContext";
import { Autocomplete } from "./Autocomplete";
import type { AutocompleteItem } from "./Autocomplete";
import type { Command } from "../../keymap/commands";
import { rankSlashCommands } from "../../ui/commandRanking";
import { listProjectFiles, detectAtToken, buildAtItems } from "./fileCompletion";
import { record as frecencyRecord, rank as frecencyRank } from "../../services/frecency";
import { useListNavigation } from "../../hooks/useListNavigation";
import { SPINNER_INTERVAL_MS, TEXTAREA_MAX_LINES, TEXTAREA_MIN_LINES } from "../../ui/constants";

export type PromptProps = {
  busy: boolean;
  placeholder?: string;
  mode: string;
  model: string;
  effort?: string;
  history: string[];
  slashCommands: Command[];
  onSubmit: (line: string) => void;
  onCycleMode: () => void;
  /** 草稿提升：弹层打开会卸载 Prompt，草稿由父级持有，重挂载时恢复 */
  draft?: string;
  onDraftChange?: (text: string) => void;
  /** 双击 Esc 取消：第一次 Esc 后显示提示 */
  escHint?: boolean;
};

const DEFAULT_PLACEHOLDER = 'Ask anything... "Fix broken tests"';

const MODE_LABELS: Record<string, string> = {
  ask: "Ask",
  auto_review: "Auto review",
  full_access: "Full access",
};

function getModeLabel(mode: string): string {
  return MODE_LABELS[normalizeApprovalMode(mode) ?? "ask"] ?? mode;
}

export function Prompt({
  busy,
  placeholder = DEFAULT_PLACEHOLDER,
  mode,
  model,
  effort,
  history,
  slashCommands,
  onSubmit,
  onCycleMode,
  draft,
  onDraftChange,
  escHint,
}: PromptProps) {
  const { theme } = useTheme();

  // Content state (synced from textarea via onContentChange)
  const [content, setContent] = useState("");

  // Autocomplete state
  const [acOpen, setAcOpen] = useState(false);

  // File @ completion state
  const [fileAcOpen, setFileAcOpen] = useState(false);
  const [fileAcItems, setFileAcItems] = useState<AutocompleteItem[]>([]);
  const [filesLoaded, setFilesLoaded] = useState(false);
  const filesRef = useRef<string[]>([]);
  const fileAtRef = useRef<{ atStart: number; atEnd: number } | null>(null);

  // History navigation state
  const [histIdx, setHistIdx] = useState<number | null>(null);

  // Spinner state for busy
  const [spinnerFrame, setSpinnerFrame] = useState(0);

  // Dynamic textarea height (1–6 lines)
  const [textareaHeight, setTextareaHeight] = useState(TEXTAREA_MIN_LINES);

  // Textarea ref for imperative operations
  const textareaRef = useRef<TextareaRenderable | null>(null);

  // Restore lifted draft once on mount (Prompt is unmounted while dialogs are open)
  useEffect(() => {
    if (draft && textareaRef.current) {
      textareaRef.current.insertText(draft);
      setContent(draft);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 排序一次，补全浮窗（展示项）和回车执行（原始 Command）共用，避免重复计算。
  const acRawCommands: Command[] = acOpen ? rankSlashCommands(slashCommands, content) : [];
  const acSuggestions: AutocompleteItem[] = acRawCommands.map((cmd) => ({
    id: cmd.id,
    label: cmd.id,
    detail: cmd.title !== cmd.id ? cmd.title : undefined,
  }));

  // 列表导航钩子（count 跟随派生值动态更新）
  const acNav = useListNavigation(acRawCommands.length);
  const fileAcNav = useListNavigation(fileAcItems.length);

  // Determine if autocomplete should be open
  const shouldShowAc = content.startsWith("/") && content.length > 0;

  // Sync acOpen with shouldShowAc
  useEffect(() => {
    if (!shouldShowAc) {
      setAcOpen(false);
      acNav.setIndex(0);
    } else {
      setAcOpen(true);
    }
  }, [shouldShowAc]);

  // Reset ac selection when content changes (new filter)
  useEffect(() => {
    acNav.setIndex(0);
  }, [content]);

  // Spinner interval when busy; reset frame when no longer busy (Bug 4)
  useEffect(() => {
    if (!busy) {
      setSpinnerFrame(0);
      return;
    }
    const frames = theme.icons.spinner;
    const id = setInterval(() => {
      setSpinnerFrame((f) => (f + 1) % frames.length);
    }, SPINNER_INTERVAL_MS);
    return () => clearInterval(id);
  }, [busy, theme.icons.spinner]);

  // 把 @token 替换为选中的文件路径；无法应用时返回 null
  const fileApplySelected = useCallback((text: string): string | null => {
    const at = fileAtRef.current;
    const selected = fileAcItems[fileAcNav.index];
    if (!at || !selected) return null;
    return text.slice(0, at.atStart) + selected.id + text.slice(at.atEnd);
  }, [fileAcItems, fileAcNav.index]);

  // 关闭文件补全浮窗并重置状态
  const fileClose = useCallback(() => {
    setFileAcOpen(false);
    fileAcNav.setIndex(0);
    fileAtRef.current = null;
  }, [fileAcNav.setIndex]);

  const syncTextareaContent = useCallback((): string => {
    const text = textareaRef.current?.plainText ?? "";
    setContent(text);
    onDraftChange?.(text);
    const lineCount = textareaRef.current?.lineCount ?? 1;
    setTextareaHeight(Math.min(TEXTAREA_MAX_LINES, Math.max(TEXTAREA_MIN_LINES, lineCount)));
    return text;
  }, [onDraftChange]);

  const updateFileCompletion = useCallback((text: string) => {
    const atResult = detectAtToken(text);
    if (atResult !== null) {
      if (!filesLoaded) {
        listProjectFiles(process.cwd()).then((files) => {
          filesRef.current = files;
          setFilesLoaded(true);
        });
      }
      fileAtRef.current = { atStart: atResult.atStart, atEnd: atResult.atEnd };
      const fileScores = frecencyRank("file");
      setFileAcItems(buildAtItems(filesRef.current, atResult.token, fileScores));
      fileAcNav.setIndex(0);
      setFileAcOpen(true);
      setAcOpen(false);
    } else {
      setFileAcOpen(false);
      fileAtRef.current = null;
    }
  }, [filesLoaded, fileAcNav.setIndex]);

  // Clear textarea imperatively
  const clearTextarea = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.clear();
    }
    setContent("");
    setHistIdx(null);
    setTextareaHeight(TEXTAREA_MIN_LINES);
    onDraftChange?.("");
  }, [onDraftChange]);

  // Handle textarea onSubmit (triggered by Return key)
  const handleTextareaSubmit = useCallback(() => {
    const text = textareaRef.current?.plainText ?? content;
    const trimmed = text.trim();
    const isSlashCommand = trimmed.startsWith("/");
    if (text !== content) {
      setContent(text);
      onDraftChange?.(text);
    }

    // If file @ completion is open, insert the selected file path
    if (fileAcOpen) {
      if (textareaRef.current) {
        const next = fileApplySelected(text);
        if (next !== null) {
          textareaRef.current.setText(next);
          setContent(next);
        }
      }
      fileClose();
      return;
    }

    // Complete prefixes like "/th"; submit exact slash lines and slash lines with args.
    if (acOpen) {
      const exactCommand = acRawCommands.some((cmd) => cmd.id === trimmed);
      const slashWithArgs = /^\/\S+\s+[\s\S]+$/.test(trimmed);
      if (exactCommand || slashWithArgs || acRawCommands.length === 0) {
        if (!busy || isSlashCommand) {
          onSubmit(trimmed);
          clearTextarea();
        }
        setAcOpen(false);
        return;
      }
      const suggestion = acRawCommands[acNav.index];
      if (suggestion) {
        suggestion.run();
        frecencyRecord("command", suggestion.id);
        clearTextarea();
        setAcOpen(false);
      }
      return;
    }

    if (trimmed === "") return;
    if (busy && !isSlashCommand) return;

    onSubmit(trimmed);
    clearTextarea();
  }, [busy, fileAcOpen, fileApplySelected, fileClose, acOpen, acRawCommands, acNav.index, content, onDraftChange, onSubmit, clearTextarea]);

  const handleTextareaPaste = useCallback((event: PasteEvent) => {
    const text = stripAnsiSequences(decodePasteBytes(event.bytes))
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");

    event.preventDefault();
    if (!text || !textareaRef.current) return;

    textareaRef.current.insertText(text);
    setTimeout(() => {
      const current = syncTextareaContent();
      updateFileCompletion(current);
    }, 0);
  }, [syncTextareaContent, updateFileCompletion]);

  // Global keyboard handler
  useKeyboard((key) => {
    if (key.name === "tab") {
      if (fileAcOpen) {
        if (textareaRef.current) {
          const next = fileApplySelected(textareaRef.current.plainText);
          if (next !== null) {
            textareaRef.current.setText(next);
            setContent(next);
          }
        }
        fileClose();
        return;
      }
      if (acOpen) {
        // Complete with highlighted suggestion
        const suggestion = acSuggestions[acNav.index];
        if (suggestion && textareaRef.current) {
          const completed = suggestion.id + " ";
          textareaRef.current.clear();
          textareaRef.current.insertText(completed);
          // Bug 2: sync content state immediately so derived acSuggestions/acOpen
          // use the updated value without waiting for the async onContentChange event.
          setContent(completed);
        }
      } else {
        onCycleMode();
      }
      return;
    }

    if (key.name === "up") {
      if (fileAcOpen) { fileAcNav.moveUp(); return; }
      if (acOpen) {
        acNav.moveUp();
      } else {
        // Bug 1: read from ref to avoid stale closure — content state may lag
        const currentText = textareaRef.current?.plainText ?? "";
        if (currentText === "") {
          // History navigation: up → older
          const newIdx =
            histIdx === null
              ? history.length - 1
              : Math.max(0, histIdx - 1);
          if (history.length > 0 && newIdx >= 0) {
            setHistIdx(newIdx);
            const entry = history[newIdx];
            if (entry !== undefined && textareaRef.current) {
              textareaRef.current.clear();
              textareaRef.current.insertText(entry);
            }
          }
        }
      }
      return;
    }

    if (key.name === "down") {
      if (fileAcOpen) { fileAcNav.moveDown(); return; }
      if (acOpen) {
        acNav.moveDown();
      } else {
        // Bug 1: read from ref to avoid stale closure
        const currentText = textareaRef.current?.plainText ?? "";
        if (currentText === "") {
          // History navigation: down → newer
          if (histIdx !== null) {
            const newIdx = histIdx + 1;
            if (newIdx >= history.length) {
              // Past the end: clear input
              setHistIdx(null);
              clearTextarea();
            } else {
              setHistIdx(newIdx);
              const entry = history[newIdx];
              if (entry !== undefined && textareaRef.current) {
                textareaRef.current.clear();
                textareaRef.current.insertText(entry);
              }
            }
          }
        }
      }
      return;
    }

    if (key.name === "escape") {
      if (fileAcOpen) { fileClose(); return; }
      if (acOpen) {
        setAcOpen(false);
        acNav.setIndex(0);
      } else {
        clearTextarea();
      }
      return;
    }
  });

  const modeLabel = getModeLabel(mode);

  const keyBindings = [
    // shift+return → newline
    { name: "return", shift: true, action: "newline" as const },
    // return → submit
    { name: "return", action: "submit" as const },
  ];

  // flexShrink=0：防止 Session 路由下被 scrollbox 挤压裁掉 meta 行。
  // 左竖条对齐 opencode：border-left + 细线字符 ┃（半格宽字形），
  // 而非 width=1 实心背景块（整格填色观感过粗）。
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      border={["left"]}
      borderColor={theme.colors.accent}
      customBorderChars={{
        topLeft: "",
        bottomLeft: "",
        vertical: "┃",
        topRight: "",
        bottomRight: "",
        horizontal: " ",
        bottomT: "",
        topT: "",
        cross: "",
        leftT: "",
        rightT: "",
      }}
    >
      {/* Content column（padding 对齐 opencode：左右 2、上下 1） */}
      <box
        flexDirection="column"
        flexGrow={1}
        backgroundColor={theme.colors.backgroundPrompt}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
      >
        {/* File @ completion floats above textarea */}
        {fileAcOpen && fileAcItems.length > 0 && (
          <Autocomplete items={fileAcItems} selectedIndex={fileAcNav.index} />
        )}

        {/* Slash command autocomplete floats above textarea */}
        {acOpen && acSuggestions.length > 0 && (
          <Autocomplete
            items={acSuggestions}
            selectedIndex={acNav.index}
          />
        )}

        {/* Multiline textarea */}
        <textarea
          ref={textareaRef}
          focused={true}
          placeholder={placeholder}
          placeholderColor={theme.colors.muted}
          keyBindings={keyBindings}
          onSubmit={handleTextareaSubmit}
          onPaste={handleTextareaPaste}
          onContentChange={() => {
            // Read plainText from ref on next tick (event has no content)
            const text = syncTextareaContent();
            // Bug 3: update height based on line count (1–6 rows)
            // Detect @ token for file completion
            const atResult = detectAtToken(text);
            if (atResult !== null) {
              if (!filesLoaded) {
                listProjectFiles(process.cwd()).then((files) => {
                  filesRef.current = files;
                  setFilesLoaded(true);
                });
              }
              fileAtRef.current = { atStart: atResult.atStart, atEnd: atResult.atEnd };
              const fileScores = frecencyRank("file");
              setFileAcItems(buildAtItems(filesRef.current, atResult.token, fileScores));
              fileAcNav.setIndex(0);
              setFileAcOpen(true);
              setAcOpen(false);
            } else {
              setFileAcOpen(false);
              fileAtRef.current = null;
            }
          }}
          height={textareaHeight}
          flexShrink={0}
        />

        {/* Meta info row（paddingTop=1 即输入区与元信息行之间的空隙，对齐 opencode） */}
        {busy ? (
          <box flexDirection="row" paddingTop={1}>
            <text fg={theme.colors.accent}>
              {theme.icons.spinner[spinnerFrame] ?? "⠋"}
            </text>
            <text fg={theme.colors.muted}>{" working..."}</text>
            {escHint && (
              <text fg={theme.colors.warning}>{" (再按 Esc 取消)"}</text>
            )}
          </box>
        ) : (
          <box flexDirection="row" paddingTop={1}>
            <text
              fg={theme.colors.accent}
              attributes={TextAttributes.BOLD}
            >
              {modeLabel}
            </text>
            <text fg={theme.colors.foreground}>{` · ${model}`}</text>
            {effort != null && effort !== "" && (
              <text fg={theme.colors.warning}>{` · ${effort}`}</text>
            )}
          </box>
        )}
      </box>
    </box>
  );
}

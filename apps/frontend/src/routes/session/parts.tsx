import React from "react";
import { KeyEvent, TextAttributes } from "@opentui/core";
import type { SyntaxStyle } from "@opentui/core";
import { useTheme } from "../../theme/ThemeContext";
import type { TranscriptItem } from "../../types";
import { ToolDiff } from "../../components/messages/ToolDiff";
import { truncateReasoning } from "./reasoning-text";

/**
 * Pick the first "summary" value from a tool_input record.
 * Priority: command > file_path > path > pattern > url; then first key.
 * Result is truncated to `maxLen` chars.
 */
function summarizeToolInput(
  toolInput: Record<string, unknown> | undefined,
  maxLen = 60,
): string {
  if (!toolInput) return "";
  const priority = ["command", "file_path", "path", "pattern", "url"];
  for (const key of priority) {
    const val = toolInput[key];
    if (val !== undefined && val !== null && typeof val === "string") {
      return val.slice(0, maxLen);
    }
  }
  // Fallback: first string-valued key
  for (const [, val] of Object.entries(toolInput)) {
    if (typeof val === "string") {
      return val.slice(0, maxLen);
    }
  }
  return "";
}

function summarizeText(text: string, maxLen = 72): string {
  const firstLine = text.split("\n")[0] ?? "";
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, Math.max(0, maxLen - 1)) + "...";
}

function countLines(text: string): number {
  return Math.max(1, text.split("\n").length);
}

function CollapsibleTranscriptBlock({
  summary,
  children,
  tone,
}: {
  summary: React.ReactNode;
  children: React.ReactNode;
  tone: string;
}) {
  const { theme } = useTheme();
  const [expanded, setExpanded] = React.useState(false);

  const toggle = React.useCallback(() => {
    setExpanded((value) => !value);
  }, []);

  const handleKeyDown = React.useCallback((event: KeyEvent) => {
    if (event.name === "enter" || event.name === "space") {
      toggle();
    }
  }, [toggle]);

  return (
    <box flexDirection="column">
      <box
        focusable
        onMouseUp={toggle}
        onKeyDown={handleKeyDown}
        backgroundColor={expanded ? theme.colors.backgroundPanel : undefined}
      >
        <text fg={tone}>
          <span fg={theme.colors.muted}>{expanded ? "[-] " : "[+] "}</span>
          {summary}
        </text>
      </box>
      {expanded ? (
        <box
          paddingLeft={2}
          paddingTop={1}
          paddingBottom={1}
        >
          {children}
        </box>
      ) : null}
    </box>
  );
}

function TranscriptPartView({
  item,
  syntax,
}: {
  item: TranscriptItem;
  syntax: SyntaxStyle;
}) {
  const { theme } = useTheme();
  const c = theme.colors;
  const icons = theme.icons;

  switch (item.role) {
    case "user":
      return (
        <text fg={c.accent}>{icons.user + item.text}</text>
      );

    case "reasoning": {
      const truncated = truncateReasoning(item.text);
      return (
        <CollapsibleTranscriptBlock
          tone={c.muted}
          summary={`思考过程${item.streaming ? " …" : ""}`}
        >
          {truncated.omitted > 0
            ? <text fg={c.muted}>{`已省略前 ${truncated.omitted} 个字符`}</text>
            : null}
          <text fg={c.muted}>{truncated.text}</text>
        </CollapsibleTranscriptBlock>
      );
    }

    case "assistant":
      return <markdown content={item.text} syntaxStyle={syntax} streaming={item.streaming === true} />;

    case "tool": {
      const toolName = item.tool_name ?? "tool";

      const isEditTool = toolName === "Edit" || toolName === "str_replace_editor";
      const isWriteTool = toolName === "Write" || toolName === "create_file";

      if (isEditTool && item.tool_input?.old_string !== undefined && item.tool_input?.new_string !== undefined) {
        const filePath = String(item.tool_input.path ?? item.tool_input.file_path ?? "file");
        const oldText = String(item.tool_input.old_string);
        const newText = String(item.tool_input.new_string);
        const addedLines = newText.split("\n").length - oldText.split("\n").length;
        const sign = addedLines >= 0 ? `+${addedLines}` : `${addedLines}`;
        return (
          <CollapsibleTranscriptBlock
            tone={c.muted}
            summary={(
              <>
                <span fg={c.muted}>{icons.tool}</span>
                <span fg={c.foreground} attributes={TextAttributes.BOLD}>{filePath}</span>
                <span fg={addedLines >= 0 ? c.success : c.error}>{" " + sign}</span>
              </>
            )}
          >
            <ToolDiff filePath={filePath} oldText={oldText} newText={newText} syntaxStyle={syntax} />
          </CollapsibleTranscriptBlock>
        );
      }

      if (isWriteTool && item.tool_input?.content !== undefined) {
        const filePath = String(item.tool_input.path ?? item.tool_input.file_path ?? "file");
        const content = String(item.tool_input.content);
        return (
          <CollapsibleTranscriptBlock
            tone={c.muted}
            summary={(
              <>
                <span fg={c.muted}>{icons.tool}</span>
                <span fg={c.foreground} attributes={TextAttributes.BOLD}>{filePath}</span>
                <span fg={c.success}>{` +${content.split("\n").length}`}</span>
              </>
            )}
          >
            <ToolDiff filePath={filePath} oldText="" newText={content} syntaxStyle={syntax} />
          </CollapsibleTranscriptBlock>
        );
      }

      const summary = summarizeToolInput(item.tool_input);
      return (
        <text fg={c.muted}>
          <span fg={c.muted}>{icons.tool}</span>
          <span fg={c.muted} attributes={TextAttributes.BOLD}>
            {toolName}
          </span>
          {summary ? <span fg={c.muted}>{" " + summary}</span> : null}
        </text>
      );
    }

    case "tool_result": {
      if (item.is_error) {
        return (
          <CollapsibleTranscriptBlock
            tone={c.error}
            summary={(
              <>
                <span fg={c.error}>{icons.error}</span>
                <span fg={c.foreground} attributes={TextAttributes.BOLD}>tool error</span>
                <span fg={c.muted}>{` ${countLines(item.text)} lines`}</span>
                {item.text ? <span fg={c.error}>{`: ${summarizeText(item.text)}`}</span> : null}
              </>
            )}
          >
            <text fg={c.error} wrapMode="word">{item.text}</text>
          </CollapsibleTranscriptBlock>
        );
      }
      return (
        <CollapsibleTranscriptBlock
          tone={c.muted}
          summary={(
            <>
              <span fg={c.muted}>{icons.tool}</span>
              <span fg={c.foreground} attributes={TextAttributes.BOLD}>output</span>
              <span fg={c.muted}>{` ${countLines(item.text)} lines`}</span>
              {item.text ? <span fg={c.muted}>{`: ${summarizeText(item.text)}`}</span> : null}
            </>
          )}
        >
          <text fg={c.muted} wrapMode="word">{item.text}</text>
        </CollapsibleTranscriptBlock>
      );
    }

    case "system":
    case "log":
      return <text fg={c.muted}>{item.text}</text>;

    default:
      return <text>{item.text}</text>;
  }
}

export const TranscriptPart = React.memo(TranscriptPartView, (previous, next) => {
  const previousItem = previous.item;
  const nextItem = next.item;
  return previous.syntax === next.syntax
    && previousItem.id === nextItem.id
    && previousItem.role === nextItem.role
    && previousItem.text === nextItem.text
    && previousItem.streaming === nextItem.streaming
    && previousItem.tool_name === nextItem.tool_name
    && previousItem.tool_input === nextItem.tool_input
    && previousItem.is_error === nextItem.is_error;
});

import { useEffect, useMemo, useState } from "react";
import type { SessionModelRetryState, SessionModelUsageSummary } from "@vykor/client";
import { useTheme } from "../../theme/ThemeContext";
import { createSyntaxStyle } from "../../theme/syntax";
import type { TranscriptItem } from "../../types";
import { TranscriptPart } from "./parts";

export type SessionProps = {
  items: TranscriptItem[];
  assistantBuffer: string;
  retry?: SessionModelRetryState;
  usage?: SessionModelUsageSummary;
  inputTokens?: number;
  outputTokens?: number;
};

export function Session({ items, assistantBuffer, retry, usage, inputTokens = 0, outputTokens = 0 }: SessionProps) {
  const { theme } = useTheme();
  const syntax = useMemo(() => createSyntaxStyle(theme), [theme]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!retry) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [retry?.generationId, retry?.attempt, retry?.nextRetryAt]);
  const seconds = retry ? Math.max(0, Math.ceil((retry.nextRetryAt - now) / 1_000)) : 0;
  const retryText = retry ? seconds > 0
    ? `连接中断，${seconds} 秒后重试（第 ${retry.retryNumber}/${retry.maxRetries} 次）`
    : `正在重新连接（第 ${retry.retryNumber}/${retry.maxRetries} 次）` : undefined;

  return (
    <scrollbox
      flexGrow={1}
      stickyScroll
      stickyStart="bottom"
      verticalScrollbarOptions={{
        trackOptions: {
          foregroundColor: theme.colors.muted,
          backgroundColor: theme.colors.backgroundPanel,
        },
      }}
    >
      <box
        flexDirection="column"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        rowGap={1}
      >
        {items.map((item, i) => (
          <TranscriptPart key={item.id ?? i} item={item} syntax={syntax} />
        ))}
        {assistantBuffer ? (
          <text wrapMode="word">{assistantBuffer}</text>
        ) : null}
        {retryText ? <text fg={theme.colors.warning}>{retryText}</text> : null}
        {usage?.incomplete ? <text fg={theme.colors.muted}>{`已知用量：${inputTokens} 输入 / ${outputTokens} 输出；部分请求用量未知`}</text> : null}
      </box>
    </scrollbox>
  );
}

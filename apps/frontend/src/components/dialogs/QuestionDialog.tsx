import { useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useTheme } from "../../theme/ThemeContext";

interface Question {
  index: number;
  text: string;
  multiple: boolean;
  options: string[];
}

function parseQuestions(value: unknown): Question[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const question = item as Record<string, unknown>;
    if (typeof question.question !== "string" || !question.question.trim()) return [];
    return [{
      index,
      text: question.question,
      multiple: question.type === "check",
      options: Array.isArray(question.options)
        ? question.options.filter((option): option is string => typeof option === "string")
        : [],
    }];
  });
}

function selection(value: string, question: Question): number[] | undefined {
  const parts = value.split(",").map(part => part.trim());
  if (!question.options.length || (!question.multiple && parts.length !== 1) || parts.some(part => !/^\d+$/.test(part))) return undefined;
  const indices = parts.map(part => Number(part) - 1);
  if (indices.some(index => index < 0 || index >= question.options.length)) return undefined;
  return [...new Set(indices)];
}

/** 单个问题发送文本。结构化问题依次使用同一个输入框，最后发送选项索引和文本。 */
export function QuestionDialog({
  modal,
  onSubmit,
}: {
  modal: Record<string, unknown>;
  onSubmit: (answer: string) => void;
}) {
  const { theme } = useTheme();
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<{ selected: Record<number, number[]>; custom: Record<number, string> }>({ selected: {}, custom: {} });
  const questions = parseQuestions(modal.questions);
  const current = questions[step];
  const question = current?.text ?? String(modal.question ?? "Question");
  const toolName = modal.tool_name ? String(modal.tool_name) : null;
  const reason = modal.reason ? String(modal.reason) : null;

  function submit(value: unknown): void {
    if (typeof value !== "string") return;
    if (!current) {
      onSubmit(value);
      return;
    }
    const text = value.trim();
    const indices = selection(text, current);
    const next = {
      selected: indices ? { ...answers.selected, [current.index]: indices } : answers.selected,
      custom: !indices && text ? { ...answers.custom, [current.index]: text } : answers.custom,
    };
    if (step === questions.length - 1) {
      onSubmit(JSON.stringify(next));
    } else {
      setAnswers(next);
      setStep(step + 1);
    }
  }

  return (
    <box flexDirection="column">
      <text fg={theme.colors.accent} attributes={TextAttributes.BOLD}>
        {current ? `? ${step + 1}/${questions.length} ${question}` : `? ${question}`}
      </text>
      {toolName ? (
        <text fg={theme.colors.muted}>{`  Tool: ${toolName}`}</text>
      ) : null}
      {reason ? (
        <text fg={theme.colors.muted}>{`  Reason: ${reason}`}</text>
      ) : null}
      {current?.options.map((option, index) => (
        <text key={index} fg={theme.colors.muted}>{`  ${index + 1}. ${option}`}</text>
      ))}
      <input
        key={step}
        focused
        placeholder={current?.options.length ? (current.multiple ? "Option numbers (1,2) or answer..." : "Option number or answer...") : "Answer..."}
        onSubmit={submit}
      />
      <text fg={theme.colors.muted}>{step < questions.length - 1 ? "  enter: next  esc: cancel" : "  enter: submit  esc: cancel"}</text>
    </box>
  );
}

import type { ToolDefinition } from "@vykor/core";

type AskUserOption = string | { label: string; description?: string };

function isAskUserOption(option: unknown): option is AskUserOption {
  if (typeof option === "string") return true;
  if (!option || typeof option !== "object" || Array.isArray(option)) return false;
  const record = option as Record<string, unknown>;
  return typeof record.label === "string" && !!record.label.trim()
    && (!Object.hasOwn(record, "description") || typeof record.description === "string")
    && Object.keys(record).every((key) => key === "label" || key === "description");
}

export const askUserTool: ToolDefinition = {
  name: "AskUser",
  description: 'Ask the interactive user a follow-up question and return the answer. Example: {"questions":[{"question":"Mode?","type":"radio","options":[{"label":"Careful","description":"Review first"},"Fast"]}]}',
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to ask the user" },
      questions: {
        type: "array",
        description: "Optional sequence of questions shown one at a time",
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            type: { type: "string", enum: ["radio", "check"] },
            options: { type: "array", items: { oneOf: [
              { type: "string" },
              { type: "object", properties: {
                label: { type: "string", minLength: 1, pattern: "\\S" }, description: { type: "string" },
              }, required: ["label"], additionalProperties: false },
            ] } },
          },
          required: ["question"],
        },
      },
    },
    required: [],
  },
  async execute(input, context) {
    const askFn = context.askUserPrompt as
      | ((q: string) => Promise<string>)
      | undefined;
    if (!askFn) {
      return {
        content: [{ type: "text", text: "ask_user_question is unavailable in this session" }],
        isError: true,
      };
    }
    const question = typeof input.question === "string" ? input.question.trim() : "";
    if (input.questions !== undefined && !Array.isArray(input.questions)) {
      return { content: [{ type: "text", text: "AskUser questions must be an array" }], isError: true };
    }
    const questions = Array.isArray(input.questions) ? input.questions : [];
    if (questions.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return true;
      const record = item as Record<string, unknown>;
      return typeof record.question !== "string" || !record.question.trim() ||
        (record.type !== undefined && record.type !== "radio" && record.type !== "check") ||
        (record.options !== undefined &&
          (!Array.isArray(record.options) || record.options.some((option) => !isAskUserOption(option))));
    })) {
      return { content: [{ type: "text", text: "AskUser contains an invalid question" }], isError: true };
    }
    if (!question && questions.length === 0) {
      return { content: [{ type: "text", text: "AskUser requires question or questions" }], isError: true };
    }
    const normalizedQuestions = questions.map((item) => {
      const record = item as Record<string, unknown>;
      if (record.options === undefined) return record;
      return { ...record, options: (record.options as AskUserOption[]).map((option) =>
        typeof option === "string" ? option
          : option.description ? `${option.label} — ${option.description}` : option.label) };
    });
    const prompt = questions.length > 0
      ? JSON.stringify({ kind: "question", questions: normalizedQuestions })
      : question;
    const answer = (await askFn(prompt)).trim();
    return { content: [{ type: "text", text: answer || "(no response)" }] };
  },
};

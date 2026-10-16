/** Query paragraphs rather than view text: the latter folds DOCX tables into a placeholder. */
export function wordParagraphText(json: string): string {
  const result = JSON.parse(json) as {
    success?: boolean;
    data?: {
      matches?: number;
      results?: Array<{ type?: string; path?: string; text?: string }>;
    };
  };
  const nodes = result.data?.results;
  if (
    result.success !== true ||
    !Array.isArray(nodes) ||
    result.data?.matches !== nodes.length
  ) {
    throw new Error("Word 段落解析结果不完整，不能作为完整文档使用。");
  }
  return nodes
    .map((node) => {
      if (
        node.type !== "paragraph" ||
        typeof node.path !== "string" ||
        (node.text !== undefined && typeof node.text !== "string")
      )
        throw new Error("Word 段落解析结果无效。");
      return `[${node.path}] ${node.text ?? ""}`;
    })
    .join("\n");
}

export function assertCompleteOfficeText(text: string): string {
  // OfficeCLI appends this footer when --max-lines limits the export.
  if (
    /^\.\.\. \(showed \d+ (?:rows|lines|slides), \d+ total, use --start\/--end to view more\)/m.test(
      text,
    )
  ) {
    throw new Error(
      "Office 文本导出已截断，无法保证内容完整；请拆分文档后重试。",
    );
  }
  return text;
}

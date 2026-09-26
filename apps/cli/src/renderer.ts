import type { StreamEvent } from "@vykor/core";

export interface RenderOptions {
  verbose?: boolean;
  printMode?: boolean;
  /** 输出样式名。"minimal" 走极简纯文本渲染;其余(default/codex/未知)走常规渲染。 */
  outputStyle?: string;
}

/**
 * 事件渲染器类，用于处理流式事件并将其格式化输出到控制台。
 * 支持文本增量、工具调用、用量统计、完成状态及错误信息的渲染。
 */
export class EventRenderer {
  private buffer = "";
  private currentTool: string | null = null;

  /**
   * 构造函数
   * @param options - 渲染配置选项
   */
  constructor(private options: RenderOptions = {}) { }

  /** 是否极简样式(渲染层唯一被特判的样式,对齐 Python)。 */
  private get isMinimal(): boolean {
    return this.options.outputStyle === "minimal";
  }

  /** 热切换输出样式(供 /output-style set 在 REPL 实时生效)。 */
  setStyle(name: string): void {
    this.options.outputStyle = name;
  }

  /**
   * 根据事件类型异步渲染对应的内容
   * @param event - 流式事件对象，包含类型及具体数据
   * @returns Promise<void>
   */
  async render(event: StreamEvent): Promise<void> {
    switch (event.type) {
      case "text_delta":
        this.renderText(event.delta);
        break;
      case "tool_use_start":
        this.renderToolStart(event.toolUse.name, event.toolUse.input);
        break;
      case "tool_use_end":
        this.renderToolEnd(event.toolUseId, event.result.content, event.result.isError);
        break;
      case "usage":
        // 仅在 verbose 模式下渲染用量信息
        if (this.options.verbose) {
          this.renderUsage(event.usage);
        }
        break;
      case "complete":
        this.renderComplete(event.stopReason);
        break;
      case "error":
        this.renderError(event.error);
        break;
      case "model_retry":
        process.stderr.write("\n上一段输出中断，以下为重新生成\n");
        process.stderr.write(`连接中断，${Math.max(0, Math.ceil((event.nextRetryAt - Date.now()) / 1000))} 秒后重试（第 ${event.retryNumber}/${event.maxRetries} 次）\n`);
        this.buffer = "";
        this.currentTool = null;
        break;
    }
  }

  /**
   * 渲染文本增量内容
   * 如果当前处于工具调用状态，先换行并重置工具状态，再输出文本
   * @param delta - 文本增量字符串
   */
  private renderText(delta: string): void {
    if (this.currentTool) {
      process.stdout.write("\n");
      this.currentTool = null;
    }
    process.stdout.write(delta);
    this.buffer += delta;
  }

  /**
   * 渲染工具调用开始信息
   * 显示工具名称及输入参数的摘要
   * @param name - 工具名称
   * @param input - 工具输入参数对象
   */
  private renderToolStart(name: string, input: Record<string, unknown>): void {
    const summary = this.summarizeToolInput(name, input);
    // minimal:极简纯文本 `  > name summary`;default/codex:`  ○ name(summary)`。
    if (this.isMinimal) {
      process.stdout.write(`\n  > ${name} ${summary}\n`);
    } else {
      process.stdout.write(`\n  ○ ${name}(${summary})\n`);
    }
    this.currentTool = name;
  }

  /**
   * 渲染工具调用结束信息
   * 在 verbose 模式下显示工具执行结果的前几行内容
   * @param _toolUseId - 工具使用ID（未直接使用）
   * @param content - 工具返回的内容数组
   * @param isError - 是否发生错误
   */
  private renderToolEnd(
    _toolUseId: string,
    content: Array<{ type: string; text?: string }>,
    isError?: boolean,
  ): void {
    if (this.options.verbose) {
      const text = content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("\n");
      if (text) {
        // minimal:纯缩进无图标;default/codex:`  ✓/✗ ` 前缀。
        const prefix = this.isMinimal ? "    " : isError ? "  ✗ " : "  ✓ ";
        const lines = text.split("\n").slice(0, 5);
        for (const line of lines) {
          process.stdout.write(`${prefix}${line}\n`);
        }
        // 如果内容超过5行，显示剩余行数提示
        if (text.split("\n").length > 5) {
          process.stdout.write(`${prefix}... (${text.split("\n").length - 5} more lines)\n`);
        }
      }
    }
    this.currentTool = null;
  }

  /**
   * 渲染 Token 用量信息
   * @param usage - 包含输入和输出 Token 数量的对象
   */
  private renderUsage(usage: { inputTokens?: number; outputTokens?: number }): void {
    process.stdout.write(
      `\n  [tokens: ${usage.inputTokens ?? 0}in / ${usage.outputTokens ?? 0}out]\n`,
    );
  }

  /**
   * 渲染完成状态
   * 根据 printMode 决定是否输出换行符
   * @param stopReason - 停止原因
   */
  private renderComplete(stopReason: string): void {
    if (!this.options.printMode) {
      process.stdout.write("\n");
    }
  }

  /**
   * 渲染错误信息到标准错误输出
   * @param error - 错误对象
   */
  private renderError(error: Error): void {
    process.stderr.write(`\n  Error: ${error.message}\n`);
  }

  /**
   * 生成工具输入参数的摘要字符串
   * 根据不同工具类型提取关键信息并截断
   * @param name - 工具名称
   * @param input - 工具输入参数对象
   * @returns 截断后的摘要字符串
   */
  private summarizeToolInput(name: string, input: Record<string, unknown>): string {
    switch (name) {
      case "Bash":
        return truncate(String(input.command ?? ""), 80);
      case "fileRead":
      case "fileWrite":
      case "fileEdit":
        return truncate(String(input.path ?? input.filePath ?? ""), 80);
      case "glob":
      case "grep":
        return truncate(String(input.pattern ?? ""), 80);
      default:
        return truncate(JSON.stringify(input), 80);
    }
  }

  /**
   * 获取累积的缓冲内容
   * @returns 缓冲字符串
   */
  getBuffer(): string {
    return this.buffer;
  }

  /**
   * 重置渲染器状态，清空缓冲区和当前工具状态
   */
  reset(): void {
    this.buffer = "";
    this.currentTool = null;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

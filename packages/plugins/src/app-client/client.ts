/** Browser-only helpers over the official MCP Apps callServerTool transport. */
declare const toolTypes: unique symbol;

/** Shared author-side types; this descriptor neither registers nor authorizes a tool. */
export interface PluginAppTool<Input extends object, Output extends object> {
  readonly name: string;
  readonly [toolTypes]?: { readonly input: Input; readonly output: Output };
}

export function definePluginAppTool<Input extends object, Output extends object>(
  name: string,
): PluginAppTool<Input, Output> {
  return Object.freeze({ name });
}

/** The common result fields; the actual transport's other fields stay available. */
export interface PluginAppResult {
  content?: readonly unknown[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface PluginAppTransport<Result extends PluginAppResult, Options> {
  callServerTool(
    request: { name: string; arguments?: Record<string, unknown> },
    options?: Options,
  ): Promise<Result>;
}

export type PluginAppToolResult<Result, Output extends object> = Omit<Result, "structuredContent"> & {
  /** A compile-time hint only. Keep the page's existing result validation. */
  structuredContent?: Output;
};

export interface PluginAppClient<Result extends PluginAppResult, Options> {
  call<Input extends object, Output extends object>(
    tool: PluginAppTool<Input, Output>,
    input: NoInfer<Input>,
    options?: Options,
  ): Promise<PluginAppToolResult<Result, Output>>;
}

/** No retries, error conversion, result parsing, or additional execution path. */
export function createPluginAppClient<Result extends PluginAppResult, Options = never>(
  app: PluginAppTransport<Result, Options>,
): PluginAppClient<Result, Options> {
  return {
    call<Input extends object, Output extends object>(tool: PluginAppTool<Input, Output>, input: NoInfer<Input>, options?: Options) {
      return app.callServerTool({ name: tool.name, arguments: input as Record<string, unknown> }, options) as
        Promise<PluginAppToolResult<Result, Output>>;
    },
  };
}

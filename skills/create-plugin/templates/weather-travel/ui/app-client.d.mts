// Generated from packages/plugins/src/app-client/client.ts. Run node scripts/sync-plugin-app-client.mjs.
/** Browser-only helpers over the official MCP Apps callServerTool transport. */
declare const toolTypes: unique symbol;
/** Shared author-side types; this descriptor neither registers nor authorizes a tool. */
export interface PluginAppTool<Input extends object, Output extends object> {
    readonly name: string;
    readonly [toolTypes]?: {
        readonly input: Input;
        readonly output: Output;
    };
}
export declare function definePluginAppTool<Input extends object, Output extends object>(name: string): PluginAppTool<Input, Output>;
/** The common result fields; the actual transport's other fields stay available. */
export interface PluginAppResult {
    content?: readonly unknown[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
}
export interface PluginAppTransport<Result extends PluginAppResult, Options> {
    callServerTool(request: {
        name: string;
        arguments?: Record<string, unknown>;
    }, options?: Options): Promise<Result>;
}
export type PluginAppToolResult<Result, Output extends object> = Omit<Result, "structuredContent"> & {
    /** A compile-time hint only. Keep the page's existing result validation. */
    structuredContent?: Output;
};
export interface PluginAppClient<Result extends PluginAppResult, Options> {
    call<Input extends object, Output extends object>(tool: PluginAppTool<Input, Output>, input: NoInfer<Input>, options?: Options): Promise<PluginAppToolResult<Result, Output>>;
}
/** No retries, error conversion, result parsing, or additional execution path. */
export declare function createPluginAppClient<Result extends PluginAppResult, Options = never>(app: PluginAppTransport<Result, Options>): PluginAppClient<Result, Options>;
export {};

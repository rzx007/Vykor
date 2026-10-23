// Generated from packages/plugins/src/app-client/client.ts. Run node scripts/sync-plugin-app-client.mjs.
export function definePluginAppTool(name) {
    return Object.freeze({ name });
}
/** No retries, error conversion, result parsing, or additional execution path. */
export function createPluginAppClient(app) {
    return {
        call(tool, input, options) {
            return app.callServerTool({ name: tool.name, arguments: input }, options);
        },
    };
}

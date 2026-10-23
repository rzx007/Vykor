import type {
  NativeToolDefinition,
  NativeToolInvocationContext,
  NativeToolPluginIdentity,
  NativeToolRegister,
  NativeToolRegistrationContext,
  VykorPluginPermissions,
  ToolResult,
} from "@vykor/plugins/sdk";

export const registerTools: NativeToolRegister = (registration) => {
  const plugin: NativeToolPluginIdentity = registration.plugin;
  const permissions: VykorPluginPermissions = registration.permissions;
  const context: NativeToolRegistrationContext = registration;
  context.log("debug", `${plugin.id}:${plugin.name}:${plugin.version}:${plugin.root}`);
  context.log("info", JSON.stringify(permissions));
  context.log("warn", "warning");
  context.log("error", "error");
  // @ts-expect-error Only the four supported log levels are exposed.
  context.log("trace", "unsupported");
  return [{
    name: "ExampleCheck",
    description: "A synchronous tool",
    inputSchema: { type: "object" },
    safeToRetry: true,
    invoke(input, invocation) {
      const actual: NativeToolInvocationContext = invocation;
      const signal: AbortSignal = actual.signal;
      const deadline: number = actual.deadline;
      const sessionId: string | undefined = actual.sessionId;
      // @ts-expect-error The plugin process does not receive terminal access.
      actual.terminal.execute("pwd");
      // @ts-expect-error The plugin process does not receive settings access.
      actual.settings.get("key");
      // @ts-expect-error The plugin process does not receive daemon jobs.
      actual.jobs.list();
      const result: ToolResult = { content: [{ type: "text", text: JSON.stringify({
        input, cwd: actual.cwd, plugin: actual.plugin, permissions: actual.permissions,
        cancelled: signal.aborted, deadline, sessionId,
      }) }] };
      return result;
    },
  }];
};

export const asyncRegisterTools: NativeToolRegister = async () => [{
  name: "AsyncExample", description: "An asynchronous tool", inputSchema: {},
  async invoke() { return { content: [{ type: "text", text: "ok" }] }; },
}];

// @ts-expect-error Tools must provide invoke.
export const missingInvoke: NativeToolDefinition = {
  name: "MissingInvoke", description: "Invalid", inputSchema: {},
};

export const invalidResult: NativeToolDefinition = {
  name: "InvalidResult", description: "Invalid", inputSchema: {},
  // @ts-expect-error Tool results must use the existing ToolResult shape.
  invoke() { return { content: [{ type: "text", text: 42 }] }; },
};

import type { IQueryEngine as QueryEngine } from "@vykor/core/engine";
import { NodeRuntimeResources } from "./node-runtime-resources.js";
import type { Settings } from "@vykor/host-config";
import type { MutableToolRegistry as IToolRegistry } from "@vykor/agent-contracts";
import type {
  StreamingMessageClient,
  PermissionChecker,
} from "@vykor/agent-contracts";

export class NodeRuntimeBuilder {
  private apiClient?: StreamingMessageClient;
  private toolRegistry?: IToolRegistry;
  private permissionChecker?: PermissionChecker;
  private hookExecutor?: import("@vykor/host-config").RegisteredHookExecutor;
  private queryEngine?: QueryEngine;

  setApiClient(client: StreamingMessageClient): this {
    this.apiClient = client;
    return this;
  }

  setToolRegistry(registry: IToolRegistry): this {
    this.toolRegistry = registry;
    return this;
  }

  setPermissionChecker(checker: PermissionChecker): this {
    this.permissionChecker = checker;
    return this;
  }

  setHookExecutor(
    executor: import("@vykor/host-config").RegisteredHookExecutor,
  ): this {
    this.hookExecutor = executor;
    return this;
  }

  setQueryEngine(engine: QueryEngine): this {
    this.queryEngine = engine;
    return this;
  }

  build(
    settings: Settings,
    runCatalogue?: import("../capabilities/node-run-catalogue.js").NodeRunCatalogue,
  ): NodeRuntimeResources {
    if (!this.apiClient) throw new Error("ApiClient is required");
    if (!this.toolRegistry) throw new Error("ToolRegistry is required");
    if (!this.permissionChecker)
      throw new Error("PermissionChecker is required");
    if (!this.hookExecutor) throw new Error("HookExecutor is required");
    if (!this.queryEngine) throw new Error("QueryEngine is required");

    return new NodeRuntimeResources(
      settings,
      this.apiClient,
      this.toolRegistry,
      this.permissionChecker,
      this.hookExecutor,
      this.queryEngine,
      runCatalogue,
    );
  }
}

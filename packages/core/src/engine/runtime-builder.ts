import { RuntimeBundle } from "../types/runtime";
import type { Settings } from "@vykor/host-config";
import type { ToolRegistry as IToolRegistry } from "../types/tools";
import type {
  StreamingMessageClient,
  IPermissionChecker,
  IHookExecutor,
  IQueryEngine,
} from "../index";

export class RuntimeBuilder {
  private apiClient?: StreamingMessageClient;
  private toolRegistry?: IToolRegistry;
  private permissionChecker?: IPermissionChecker;
  private hookExecutor?: IHookExecutor;
  private queryEngine?: IQueryEngine;

  setApiClient(client: StreamingMessageClient): this {
    this.apiClient = client;
    return this;
  }

  setToolRegistry(registry: IToolRegistry): this {
    this.toolRegistry = registry;
    return this;
  }

  setPermissionChecker(checker: IPermissionChecker): this {
    this.permissionChecker = checker;
    return this;
  }

  setHookExecutor(executor: IHookExecutor): this {
    this.hookExecutor = executor;
    return this;
  }

  setQueryEngine(engine: IQueryEngine): this {
    this.queryEngine = engine;
    return this;
  }

  build(settings: Settings): RuntimeBundle {
    if (!this.apiClient) throw new Error("ApiClient is required");
    if (!this.toolRegistry) throw new Error("ToolRegistry is required");
    if (!this.permissionChecker) throw new Error("PermissionChecker is required");
    if (!this.hookExecutor) throw new Error("HookExecutor is required");
    if (!this.queryEngine) throw new Error("QueryEngine is required");

    return new RuntimeBundle(
      settings,
      this.apiClient,
      this.toolRegistry,
      this.permissionChecker,
      this.hookExecutor,
      this.queryEngine,
    );
  }
}

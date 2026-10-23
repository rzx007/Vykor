export type PluginDiagnosticSeverity = "info" | "warning" | "error";
export type PluginDiagnosticPhase =
  | "discover"
  | "parse"
  | "validate"
  | "load"
  | "activate"
  | "install";

/** 插件各阶段统一返回的可展示、可机器判断的诊断。 */
export interface PluginDiagnostic {
  severity: PluginDiagnosticSeverity;
  phase: PluginDiagnosticPhase;
  code: string;
  message: string;
  pluginId?: string;
  component?: string;
  path?: string;
  details?: unknown;
}

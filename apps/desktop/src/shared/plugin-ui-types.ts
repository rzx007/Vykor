import type {
  DismissPluginUiInput, InvokePluginUiActionInput, PluginUiActionReceipt, PluginUiActionDescription,
  PluginUiAvailability, PluginUiInstanceRecord, PluginUiSurface, PluginUiViewSnapshot,
} from "@vykor/client";
export interface DesktopPluginUiTarget { sessionId: string; instanceId: string }
export interface DesktopPluginUiMountInput extends DesktopPluginUiTarget { surface: PluginUiSurface }
export interface PluginUiHostState {
  snapshot: PluginUiViewSnapshot; plugin: { id: string; version: string }; title: string;
  availability: PluginUiAvailability; surfaces: PluginUiSurface[];
  actions: Array<Pick<PluginUiActionDescription, "id" | "label" | "toolName" | "completion">>;
}
export interface DesktopPluginUiMountResult { mountId: string; url: string; state: PluginUiHostState }
export interface DesktopPluginUiCapabilities { available: boolean }
export interface DesktopPluginUiAPI {
  capabilities(): Promise<DesktopPluginUiCapabilities>;
  mount(input: DesktopPluginUiMountInput): Promise<DesktopPluginUiMountResult>;
  getState(input: DesktopPluginUiTarget): Promise<PluginUiHostState>;
  invokeAction(input: { mountId: string; input: InvokePluginUiActionInput }): Promise<PluginUiActionReceipt>;
  getAction(input: { mountId: string; requestId: string }): Promise<PluginUiActionReceipt>;
  dismiss(input: DesktopPluginUiTarget & { input: DismissPluginUiInput }): Promise<PluginUiInstanceRecord>;
  unmount(input: { mountId: string }): Promise<void>;
  onRevoked(listener: (event: { mountId: string }) => void): () => void;
}

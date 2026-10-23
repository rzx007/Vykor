// @ts-check
import { definePluginAppTool } from '../ui/app-client.mjs';

/** @typedef {{ line: number, code: 'tab-indentation' | 'trailing-whitespace' }} Finding */
/** @typedef {{ text: string, findings: Finding[], truncated: boolean }} Inspection */

export const textInspectorTools = {
  /** @type {import('../ui/app-client.mjs').PluginAppTool<{ text: string }, Inspection>} */
  check: definePluginAppTool('TextInspectorCheck'),
  /** @type {import('../ui/app-client.mjs').PluginAppTool<{ text: string, selected: string[] }, Inspection>} */
  preview: definePluginAppTool('TextInspectorPreview'),
};

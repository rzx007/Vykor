// @ts-check
import { definePluginAppTool } from '../ui/app-client.mjs';

/** @typedef {{ id: string, uri: string, revision: number, text: string }} Note */
/** @typedef {{ expectedRevision: number, operationId: string, text: string }} SaveNoteInput */
/** @typedef {Note & { operationId: string, saved: boolean, conflict?: boolean, duplicate?: boolean }} NoteReceipt */

export const noteTools = {
  /** @type {import('../ui/app-client.mjs').PluginAppTool<Record<string, never>, Note>} */
  read: definePluginAppTool('read_note'),
  /** @type {import('../ui/app-client.mjs').PluginAppTool<SaveNoteInput & { start: number, end: number }, NoteReceipt>} */
  apply: definePluginAppTool('apply_note_operations'),
  /** @type {import('../ui/app-client.mjs').PluginAppTool<Record<string, never>, { notes: Array<{ id: string, uri: string, title: string }> }>} */
  list: definePluginAppTool('list_notes'),
  /** @type {import('../ui/app-client.mjs').PluginAppTool<SaveNoteInput, NoteReceipt>} */
  save: definePluginAppTool('save_note_draft'),
};

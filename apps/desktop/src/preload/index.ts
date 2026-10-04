import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

import { desktopAPI } from './desktop-api'

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (!process.isMainFrame) {
  // Never expose the desktop bridge to plugin or other child frames.
} else if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('desktop', desktopAPI)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.desktop = desktopAPI
}

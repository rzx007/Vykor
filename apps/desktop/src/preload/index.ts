import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

import { desktopAPI } from './desktop-api'

const platformAPI = { ...electronAPI, process: { ...electronAPI.process, arch: process.arch } }
const maintenanceOnly = process.argv.includes('--data-root-maintenance')
const exposedAPI = maintenanceOnly ? { businessData: desktopAPI.businessData, dataRootMaintenance: true,
  maintenance: Object.fromEntries(['dataRootInfo', 'inspectDataRoot', 'migrateDataRoot', 'recoverDataRoot', 'chooseDirectory'].map(key => [key, desktopAPI.maintenance[key as keyof typeof desktopAPI.maintenance]])) } : desktopAPI

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (!process.isMainFrame) {
  // Never expose the desktop bridge to plugin or other child frames.
} else if (process.contextIsolated) {
  try {
    if (!maintenanceOnly) contextBridge.exposeInMainWorld('electron', platformAPI)
    contextBridge.exposeInMainWorld('desktop', exposedAPI)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = platformAPI
  // @ts-ignore (define in dts)
  window.desktop = exposedAPI as typeof desktopAPI
}

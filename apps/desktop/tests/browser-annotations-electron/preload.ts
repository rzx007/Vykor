import { contextBridge, ipcRenderer } from "electron"
import { IpcChannels } from "../../src/shared/ipc-channels"
const invoke = (channel: string, input: unknown) => ipcRenderer.invoke(channel, input)
contextBridge.exposeInMainWorld("desktop", {
  browser: {
    updateTab: (input: unknown) => invoke(IpcChannels.browserTabUpdate, input),
    readAnnotations: (input: unknown) => invoke(IpcChannels.browserReadAnnotations, input),
    setAnnotationMode: (input: unknown) => invoke(IpcChannels.browserSetAnnotationMode, input),
    addAnnotation: (input: unknown) => invoke(IpcChannels.browserAddAnnotation, input),
    focusAnnotation: (input: unknown) => invoke(IpcChannels.browserFocusAnnotation, input),
    removeAnnotation: (input: unknown) => invoke(IpcChannels.browserRemoveAnnotation, input),
  },
  window: { material: null, openExternal: async () => {}, getMaterial: async () => null },
})

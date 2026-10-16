import { ElectronAPI } from "@electron-toolkit/preload"
import type * as React from "react"
import type { DesktopAPI } from "../shared/desktop-api-contract"

declare global {
  interface Window {
    electron: ElectronAPI & { process: ElectronAPI["process"] & { arch: string } }
    desktop: DesktopAPI
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        allowpopups?: string
        autosize?: string
        disableblinkfeatures?: string
        httpreferrer?: string
        partition?: string
        preload?: string
        src?: string
        insertCSS?: (css: string) => Promise<string>
        useragent?: string
        webpreferences?: string
      }
    }
  }
}

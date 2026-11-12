import { app } from 'electron'

let forceQuit = false

export function isForceQuit(): boolean {
  return forceQuit
}

export function setForceQuit(value: boolean): void {
  forceQuit = value
}

export function quitApp(): void {
  forceQuit = true
  app.quit()

}

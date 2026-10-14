// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest"
import { readPluginUiAppearance } from "./plugin-ui-appearance"
afterEach(() => { document.documentElement.removeAttribute("style"); document.documentElement.removeAttribute("class"); delete document.documentElement.dataset.reducedMotion })
it("reads applied colors, font and reduced motion instead of preset defaults", () => {
  const root = document.documentElement
  root.classList.add("dark"); root.dataset.reducedMotion = "true"
  root.style.fontFamily = "CustomSans"; root.style.fontSize = "19px"
  for (const name of ["background", "foreground", "muted", "muted-foreground", "primary", "primary-foreground", "accent", "border", "destructive"]) root.style.setProperty("--" + name, "#123456")
  expect(readPluginUiAppearance()).toMatchObject({ theme: "dark", fontFamily: "CustomSans", fontSizePx: 19, reducedMotion: true, colors: { background: "#123456", primary: "#123456" } })
});
it("returns a legal neutral appearance when CSS cannot be read", () => {
  expect(readPluginUiAppearance()).toMatchObject({ fontSizePx: 14, colors: { background: "#ffffff", foreground: "#202020" } })
});
it("uses the applied UI size and font rather than html defaults", () => {
  const root = document.documentElement
  root.style.fontFamily = "DefaultHtml"; root.style.fontSize = "16px"
  root.style.setProperty("--font-sans", "ChosenUi"); root.style.setProperty("--ui-font-size", "18px")
  for (const name of ["background", "foreground", "muted", "muted-foreground", "primary", "primary-foreground", "accent", "border", "destructive"]) root.style.setProperty("--" + name, "#123456")
  expect(readPluginUiAppearance()).toMatchObject({ fontFamily: "ChosenUi", fontSizePx: 18 })
});
it("normalizes multiline CSS tokens before sending appearance", () => {
  const root = document.documentElement
  root.classList.add("dark")
  root.style.setProperty("--font-sans", '"Chosen UI",\n  sans-serif')
  root.style.setProperty("--ui-font-size", "14px")
  for (const name of ["background", "foreground", "muted", "muted-foreground", "primary", "primary-foreground", "accent", "border", "destructive"])
    root.style.setProperty("--" + name, "\n #123456 \n")
  expect(readPluginUiAppearance()).toMatchObject({ theme: "dark", fontFamily: '"Chosen UI", sans-serif', colors: { background: "#123456" } })
});

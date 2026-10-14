import { expect, it } from "vitest";
import * as protocol from "./index.js";

const appearance = {
  theme: "dark", colors: { background: "#111", foreground: "#fff", muted: "#222", mutedForeground: "#aaa",
    primary: "#369", primaryForeground: "#fff", accent: "#246", border: "#555", destructive: "#f33" },
  fontFamily: "system-ui, sans-serif", fontSizePx: 14, reducedMotion: true,
};

it("accepts a complete appearance and owns its nested colors", () => {
  const parsed = protocol.parsePluginUiAppearance(appearance);
  expect(parsed).toEqual(appearance);
  parsed.colors.background = "#000";
  expect(appearance.colors.background).toBe("#111");
});

it("rejects extra CSS, URLs, rule fragments and incomplete palettes", () => {
  for (const changes of [
    { cssText: "body{}" }, { theme: undefined }, { reducedMotion: undefined },
    { colors: { ...appearance.colors, extra: "#fff" } },
    { colors: { ...appearance.colors, border: undefined } },
    ...["url(https://host/x)", "#fff; color: red", "red{}", "red/*hi*/", "var(--remote)", "x".repeat(129), ""]
      .map(background => ({ colors: { ...appearance.colors, background } })),
    { fontFamily: "url(x)" }, { fontFamily: "serif; color:red" }, { fontFamily: "x".repeat(257) },
    { fontSizePx: 7 }, { fontSizePx: 33 }, { fontSizePx: NaN }, { fontSizePx: Infinity },
  ]) expect(() => protocol.parsePluginUiAppearance({ ...appearance, ...changes })).toThrow();
  for (const fontSizePx of [8, 32])
    expect(protocol.parsePluginUiAppearance({ ...appearance, fontSizePx }).fontSizePx).toBe(fontSizePx);
});

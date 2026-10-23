import { describe, it, expect } from "vitest";
import { ThemeManager, defaultTheme, darkTheme, minimalTheme, cyberpunkTheme, solarizedTheme, builtinThemes } from "../index.js";
import type { ThemeDefinition } from "../index.js";

describe("builtin themes", () => {
  it("exports 5 themes", () => {
    expect(builtinThemes).toHaveLength(5);
  });

  it("defaultTheme has required colors", () => {
    expect(defaultTheme.name).toBe("default");
    expect(defaultTheme.colors.primary).toBeTruthy();
  });

  it("darkTheme has dark background", () => {
    expect(darkTheme.colors.background).toBeTruthy();
  });
});

describe("ThemeManager", () => {
  it("has 5 builtin themes", () => {
    const mgr = new ThemeManager();
    expect(mgr.list()).toHaveLength(5);
  });

  it("get returns a builtin theme", () => {
    const mgr = new ThemeManager();
    expect(mgr.get("default")).toBeDefined();
    expect(mgr.get("dark")).toBeDefined();
  });

  it("get returns undefined for unknown theme", () => {
    const mgr = new ThemeManager();
    expect(mgr.get("nope")).toBeUndefined();
  });

  it("setActive changes active theme", () => {
    const mgr = new ThemeManager();
    expect(mgr.setActive("dark")).toBe(true);
    expect(mgr.getActive().name).toBe("dark");
  });

  it("setActive returns false for unknown theme", () => {
    const mgr = new ThemeManager();
    expect(mgr.setActive("nope")).toBe(false);
  });

  it("getActive returns default initially", () => {
    const mgr = new ThemeManager();
    expect(mgr.getActive().name).toBe("default");
  });

  it("register adds a custom theme", () => {
    const mgr = new ThemeManager();
    const custom: ThemeDefinition = {
      name: "custom",
      displayName: "Custom",
      colors: {
        primary: "#000",
        secondary: "#111",
        accent: "#222",
        background: "#fff",
        foreground: "#000",
        muted: "#888",
        error: "#f00",
        success: "#0f0",
        warning: "#ff0",
        border: "#ccc",
      },
    };
    mgr.register(custom);
    expect(mgr.get("custom")).toBe(custom);
    expect(mgr.list()).toHaveLength(6);
  });
});

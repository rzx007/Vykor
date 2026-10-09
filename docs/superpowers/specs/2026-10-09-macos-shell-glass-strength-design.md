# macOS Window-Shell Glass Strength

## Goal

Make Vykor's macOS sidebar and window chrome read more clearly as frosted glass,
while keeping the main workspace opaque. Reuse the existing `glassStrength`
appearance preference; do not add a native dependency.

## Current behavior and comparison

Vykor already creates a macOS window with native `under-window` vibrancy. Its
renderer tints the whole shell, but the tint is fixed and the document body and
main layout both paint that shell color. The main workspace uses its own opaque
`--conversation` color. The `glassStrength` preference currently only changes
the Windows tint.

Synara's useful pattern is to expose translucency as a user preference and avoid
stacking translucent fills. Its adjustable native blur add-on is not needed for
this change: Vykor already has native vibrancy, and adding a platform-specific
native module would increase packaging and maintenance risk.

## Behavior

- Keep the existing “透明磨玻璃 / 不透明” choice and native material behavior.
- On macOS, show the existing “透光强度” slider when glass is active. Reuse the
  saved 0–100 `glassStrength` value; lower values mean a denser tint and higher
  values let more of the blurred desktop show through.
- Use the existing default of 35. Map the shell tint to `100% - glassStrength%`.
- Paint the translucent shell tint once, not once on the body and again on the
  main layout.
- Keep the conversation/workspace surface and its content unchanged and opaque.
- Keep the slider disabled when glass is inactive, including when macOS
  “Reduce transparency” forces the window to fall back to opaque.
- Do not change Windows/Linux behavior or copy Synara's native blur add-on.

## Implementation boundaries

- Extend the current appearance settings UI to expose the shared slider on
  macOS as well as Windows.
- Apply the preference to the macOS translucent shell token in the renderer.
- Remove only the duplicate shell paint that compounds translucency. Retain
  `--conversation` and other content-surface colors.
- Keep native `under-window` vibrancy and existing unavailable-state messaging.

## Verification

- Appearance settings tests verify the slider is available on macOS, reflects
  the saved value, updates that value, and is disabled when glass is inactive.
- Renderer appearance tests verify glass strength reaches the shell styling and
  does not change the opaque conversation surface.
- Run the focused desktop tests and the desktop renderer typecheck.
- macOS visual appearance remains to be confirmed on a real macOS system; the
  Windows development host cannot validate WindowServer compositing.

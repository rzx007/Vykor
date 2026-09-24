import { useTerminalDimensions } from "@opentui/react";
import { TextAttributes } from "@opentui/core";
import { useTheme } from "../theme/ThemeContext";

// 宽度不足时逐级降级，给标志两侧留出终端边距。
const BLOCK_MIN_WIDTH = 60;
const SLICK_MIN_WIDTH = 45;

export function Logo() {
  const { theme } = useTheme();
  const { width } = useTerminalDimensions();

  if (width < SLICK_MIN_WIDTH) {
    // Narrow fallback: single-line bold text with span dual-color
    return (
      <text attributes={TextAttributes.BOLD}>
        <span fg={theme.colors.muted}>Vy</span>
        <span fg={theme.colors.foreground}>kor</span>
      </text>
    );
  }

  const font = width >= BLOCK_MIN_WIDTH ? "block" : "slick";
  // Two side-by-side ascii-font elements for dual-color effect
  return (
    <box flexDirection="row">
      <ascii-font text="Vy" font={font} color={theme.colors.muted} />
      <ascii-font text="kor" font={font} color={theme.colors.foreground} />
    </box>
  );
}

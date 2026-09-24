import { test, expect } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { Home } from "./Home";
import { ThemeProvider } from "../theme/ThemeContext";

test("Home renders logo area, children slot, and hint row (80x24)", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <Home>
        <text>PROMPT_SLOT</text>
      </Home>
    </ThemeProvider>,
    { width: 80, height: 24 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  // Children slot text rendered
  expect(frame).toContain("PROMPT_SLOT");

  // Hint row contains the key bindings
  expect(frame).toContain("ctrl+p commands");
  expect(frame).toContain("tab mode");

  // At 80 columns the shorter Vykor name fits the block logo.
  expect(frame).toContain("██╗");

  renderer.destroy();
});

test("Home narrow fallback text at width 30", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <Home>
        <text>PROMPT_SLOT</text>
      </Home>
    </ThemeProvider>,
    { width: 30, height: 24 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  // At narrow width the Logo falls back to plain text.
  expect(frame).toContain("Vykor");

  renderer.destroy();
});

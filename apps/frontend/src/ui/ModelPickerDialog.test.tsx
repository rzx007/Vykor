import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { ModelInfo, ModelProviderInfo } from "@vykor/client";

import { ThemeProvider } from "../theme/ThemeContext";
import { ModelPickerDialog } from "./ModelPickerDialog";

function model(providerName: string, id: string, label: string, hint?: string): ModelInfo {
  return {
    id,
    label,
    provider: providerName,
    providerName,
    hint,
  };
}

function linePosition(frame: string, text: string): { x: number; y: number } {
  const lines = frame.split("\n");
  const y = lines.findIndex((line) => line.includes(text));
  expect(y).toBeGreaterThanOrEqual(0);
  const x = lines[y]?.indexOf(text) ?? -1;
  expect(x).toBeGreaterThanOrEqual(0);
  return { x, y };
}

const providers: ModelProviderInfo[] = [
  {
    name: "openrouter",
    displayName: "OpenRouter",
    models: [
      model("openrouter", "alpha", "Alpha", "Free"),
      model("openrouter", "beta", "Beta", "Free"),
    ],
  },
  {
    name: "deepseek",
    displayName: "DeepSeek",
    models: [
      model("deepseek", "deepseek/deepseek-v4-flash", "DeepSeek V4 Flash"),
      model("deepseek", "deepseek/deepseek-v4-pro", "DeepSeek V4 Pro"),
    ],
  },
];

test("renders provider groups with model rows", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <ModelPickerDialog
        providers={providers}
        currentModel="alpha"
        onSelect={() => undefined}
      />
    </ThemeProvider>,
    { width: 80, height: 24 },
  );

  await renderOnce();
  const frame = captureCharFrame();
  expect(frame).toContain("OpenRouter");
  expect(frame).toContain("Alpha");
  expect(frame).toContain("Beta");
  expect(frame).toContain("DeepSeek");
  expect(frame).toContain("DeepSeek V4 Flash");
  expect(frame).toContain("DeepSeek V4 Pro");

  renderer.destroy();
});

test("mouse click selects the clicked model", async () => {
  let selected: string | undefined;

  const { renderer, renderOnce, captureCharFrame, mockMouse } = await testRender(
    <ThemeProvider>
      <ModelPickerDialog
        providers={providers}
        currentModel="alpha"
        onSelect={(next) => {
          selected = next.id;
        }}
      />
    </ThemeProvider>,
    { width: 80, height: 24 },
  );

  await renderOnce();
  const { x, y } = linePosition(captureCharFrame(), "Beta");
  await mockMouse.click(x, y);
  await renderOnce();

  expect(selected).toBe("beta");

  renderer.destroy();
});

test("mouse wheel scrolls long model lists", async () => {
  const longProviders: ModelProviderInfo[] = [
    {
      name: "openrouter",
      displayName: "OpenRouter",
      models: Array.from({ length: 20 }, (_, index) =>
        model("openrouter", `model-${index}`, `Model ${index}`),
      ),
    },
  ];

  const { renderer, renderOnce, waitForFrame, captureCharFrame, mockMouse } = await testRender(
    <ThemeProvider>
      <ModelPickerDialog
        providers={longProviders}
        currentModel="model-0"
        onSelect={() => undefined}
      />
    </ThemeProvider>,
    { width: 80, height: 24 },
  );

  await renderOnce();
  let frame = captureCharFrame();
  expect(frame).not.toContain("Model 19");

  const { x, y } = linePosition(frame, "Model 0");
  for (let i = 0; i < 14; i += 1) {
    await mockMouse.scroll(x, y, "down");
  }
  await renderOnce();
  await waitForFrame((nextFrame) => nextFrame.includes("Model 19"));

  frame = captureCharFrame();
  expect(frame).toContain("Model 19");

  renderer.destroy();
});

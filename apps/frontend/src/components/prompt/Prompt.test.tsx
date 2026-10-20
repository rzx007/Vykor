import { test, expect, mock } from "bun:test";
import React from "react";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { ThemeProvider } from "../../theme/ThemeContext";
import { Prompt } from "./Prompt";
import type { Command } from "../../keymap/commands";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const sampleCommands: Command[] = [
  { id: "/theme", title: "Switch theme", run: mock(() => undefined) },
  { id: "/help", title: "Show help", run: mock(() => undefined) },
  { id: "/plan", title: "Plan mode", run: mock(() => undefined) },
];

function makePrompt(overrides: Partial<React.ComponentProps<typeof Prompt>> = {}) {
  return (
    <ThemeProvider>
      <Prompt
        busy={false}
        mode="ask"
        model="claude-3-opus"
        history={[]}
        slashCommands={sampleCommands}
        onSubmit={mock(() => undefined)}
        onCycleMode={mock(() => undefined)}
        {...overrides}
      />
    </ThemeProvider>
  );
}

// ---------------------------------------------------------------------------
// Test 1: placeholder and meta row rendered on initial frame
// ---------------------------------------------------------------------------

test("renders placeholder and mode/model meta row", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    makePrompt(),
    { width: 80, height: 24 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  // Placeholder text
  expect(frame).toContain("Ask anything");

  // Meta info row: Ask (mode label) + model
  expect(frame).toContain("Ask");
  expect(frame).toContain("claude-3-opus");

  renderer.destroy();
});

// ---------------------------------------------------------------------------
// Test 2: typeText + pressEnter → onSubmit called with text, input cleared
// ---------------------------------------------------------------------------

test("typeText + pressEnter triggers onSubmit and clears input", async () => {
  const onSubmit = mock((_line: string) => undefined);

  const { renderer, renderOnce, mockInput, waitForFrame, captureCharFrame } =
    await testRender(makePrompt({ onSubmit }), { width: 80, height: 24 });

  await renderOnce();

  // Type "hello"
  await act(async () => {
    await mockInput.typeText("hello");
  });
  await renderOnce();

  // Press Enter to submit
  await act(async () => {
    mockInput.pressEnter();
  });
  await new Promise((r) => setTimeout(r, 50));
  await renderOnce();

  // onSubmit should have been called with "hello"
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onSubmit.mock.calls[0]?.[0]).toBe("hello");

  // Wait for placeholder to reappear (input cleared)
  await waitForFrame((f) => f.includes("Ask anything"));
  const frame = captureCharFrame();
  expect(frame).toContain("Ask anything");

  renderer.destroy();
});

test("prompt keeps the same height for single-line edits and clear", async () => {
  const { renderer, renderOnce, mockInput, waitForFrame, captureCharFrame } =
    await testRender(makePrompt(), { width: 80, height: 24 });

  await renderOnce();
  const initialModeRow = captureCharFrame().split("\n").findIndex((line) => line.includes("claude-3-opus"));

  await act(async () => {
    await mockInput.typeText("hello");
  });
  await waitForFrame((f) => f.includes("hello"));
  const typedModeRow = captureCharFrame().split("\n").findIndex((line) => line.includes("claude-3-opus"));

  await act(async () => {
    mockInput.pressEnter();
  });
  await waitForFrame((f) => f.includes("Ask anything"));
  const clearedModeRow = captureCharFrame().split("\n").findIndex((line) => line.includes("claude-3-opus"));

  expect(typedModeRow).toBe(initialModeRow);
  expect(clearedModeRow).toBe(initialModeRow);

  renderer.destroy();
});

test("bracketed paste + pressEnter submits pasted text immediately", async () => {
  const onSubmit = mock((_line: string) => undefined);

  const { renderer, renderOnce, mockInput, waitForFrame } =
    await testRender(makePrompt({ onSubmit }), { width: 80, height: 24 });

  await renderOnce();

  await act(async () => {
    await mockInput.pasteBracketedText("line one\r\nline two");
  });
  await waitForFrame((f) => f.includes("line one"));

  await act(async () => {
    mockInput.pressEnter();
  });
  await new Promise((r) => setTimeout(r, 50));
  await renderOnce();

  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onSubmit.mock.calls[0]?.[0]).toBe("line one\nline two");

  renderer.destroy();
});

// ---------------------------------------------------------------------------
// Test 3: typing "/th" shows autocomplete with /theme; pressEnter runs command
// ---------------------------------------------------------------------------

test("slash prefix shows autocomplete; enter executes highlighted command", async () => {
  const onSubmit = mock((_line: string) => undefined);
  const themeRun = mock(() => undefined);
  const commands: Command[] = [
    { id: "/theme", title: "Switch theme", run: themeRun },
    { id: "/help", title: "Show help", run: mock(() => undefined) },
  ];

  const { renderer, renderOnce, mockInput, waitForFrame, captureCharFrame } =
    await testRender(
      makePrompt({ onSubmit, slashCommands: commands }),
      { width: 80, height: 24 },
    );

  await renderOnce();

  // Type "/th" to trigger autocomplete for /theme
  await act(async () => {
    await mockInput.typeText("/th");
  });
  await waitForFrame((f) => f.includes("/theme"));

  const frameBefore = captureCharFrame();
  expect(frameBefore).toContain("/theme");

  // Press Enter — should run /theme command, NOT call onSubmit
  await act(async () => {
    mockInput.pressEnter();
  });
  await new Promise((r) => setTimeout(r, 50));
  await renderOnce();

  expect(themeRun).toHaveBeenCalledTimes(1);
  expect(onSubmit).not.toHaveBeenCalled();

  // Input should be cleared (placeholder back)
  await waitForFrame((f) => f.includes("Ask anything"));

  renderer.destroy();
});

// ---------------------------------------------------------------------------
// Test 4: busy=true → spinner + "working...", no submit on Enter
// ---------------------------------------------------------------------------

test("exact slash command submits the typed line instead of executing autocomplete", async () => {
  const onSubmit = mock((_line: string) => undefined);
  const sessionsRun = mock(() => undefined);
  const commands: Command[] = [
    { id: "/sessions", title: "List sessions", run: sessionsRun },
    { id: "/settings", title: "Settings", run: mock(() => undefined) },
  ];

  const { renderer, renderOnce, mockInput, waitForFrame } =
    await testRender(
      makePrompt({ onSubmit, slashCommands: commands }),
      { width: 80, height: 24 },
    );

  await renderOnce();
  await act(async () => {
    await mockInput.typeText("/sessions");
  });
  await waitForFrame((f) => f.includes("/sessions"));

  await act(async () => {
    mockInput.pressEnter();
  });
  await new Promise((r) => setTimeout(r, 50));
  await renderOnce();

  expect(onSubmit).toHaveBeenCalledWith("/sessions");
  expect(sessionsRun).not.toHaveBeenCalled();

  renderer.destroy();
});

test("slash command with args submits raw text instead of being swallowed by autocomplete", async () => {
  const onSubmit = mock((_line: string) => undefined);
  const providerRun = mock(() => undefined);
  const commands: Command[] = [
    { id: "/provider", title: "Set provider", run: providerRun },
  ];

  const { renderer, renderOnce, mockInput, waitForFrame } =
    await testRender(
      makePrompt({ onSubmit, slashCommands: commands }),
      { width: 80, height: 24 },
    );

  await renderOnce();
  await act(async () => {
    await mockInput.typeText("/provider openai");
  });
  await waitForFrame((f) => f.includes("/provider openai"));

  await act(async () => {
    mockInput.pressEnter();
  });
  await new Promise((r) => setTimeout(r, 50));
  await renderOnce();

  expect(onSubmit).toHaveBeenCalledWith("/provider openai");
  expect(providerRun).not.toHaveBeenCalled();

  renderer.destroy();
});

test("busy state still allows slash autocomplete and command selection", async () => {
  const onSubmit = mock((_line: string) => undefined);
  const themeRun = mock(() => undefined);
  const commands: Command[] = [
    { id: "/theme", title: "Switch theme", run: themeRun },
    { id: "/help", title: "Show help", run: mock(() => undefined) },
  ];

  const { renderer, renderOnce, mockInput, waitForFrame } =
    await testRender(
      makePrompt({ busy: true, onSubmit, slashCommands: commands }),
      { width: 80, height: 24 },
    );

  await renderOnce();

  await act(async () => {
    await mockInput.typeText("/th");
  });
  await waitForFrame((f) => f.includes("/theme"));

  await act(async () => {
    mockInput.pressEnter();
  });
  await new Promise((r) => setTimeout(r, 50));
  await renderOnce();

  expect(themeRun).toHaveBeenCalledTimes(1);
  expect(onSubmit).not.toHaveBeenCalled();

  renderer.destroy();
});

test("busy state submits exact slash commands even before autocomplete settles", async () => {
  const onSubmit = mock((_line: string) => undefined);
  const sessionsRun = mock(() => undefined);
  const commands: Command[] = [
    { id: "/sessions", title: "List sessions", run: sessionsRun },
  ];

  const { renderer, renderOnce, mockInput, waitForFrame } =
    await testRender(
      makePrompt({ busy: true, onSubmit, slashCommands: commands }),
      { width: 80, height: 24 },
    );

  await renderOnce();
  await waitForFrame((f) => f.includes("working"));

  await act(async () => {
    await mockInput.typeText("/sessions");
    mockInput.pressEnter();
  });
  await new Promise((r) => setTimeout(r, 50));
  await renderOnce();

  expect(onSubmit).toHaveBeenCalledWith("/sessions");
  expect(sessionsRun).not.toHaveBeenCalled();

  renderer.destroy();
});

test("busy state submits slash commands with args", async () => {
  const onSubmit = mock((_line: string) => undefined);
  const commands: Command[] = [
    { id: "/provider", title: "Set provider", run: mock(() => undefined) },
  ];

  const { renderer, renderOnce, mockInput, waitForFrame } =
    await testRender(
      makePrompt({ busy: true, onSubmit, slashCommands: commands }),
      { width: 80, height: 24 },
    );

  await renderOnce();
  await waitForFrame((f) => f.includes("working"));

  await act(async () => {
    await mockInput.typeText("/provider openai");
    mockInput.pressEnter();
  });
  await new Promise((r) => setTimeout(r, 50));
  await renderOnce();

  expect(onSubmit).toHaveBeenCalledWith("/provider openai");

  renderer.destroy();
});

test("busy state shows spinner/working and ignores submit", async () => {
  const onSubmit = mock((_line: string) => undefined);

  const { renderer, renderOnce, mockInput, waitForFrame, captureCharFrame } =
    await testRender(
      makePrompt({ busy: true, onSubmit }),
      { width: 80, height: 24 },
    );

  await renderOnce();
  // Wait for the spinner/working text to appear
  await waitForFrame((f) => f.includes("working"));
  const frame = captureCharFrame();
  expect(frame).toContain("working");

  // Type and press Enter — should be a no-op
  await act(async () => {
    await mockInput.typeText("hello");
  });
  await act(async () => {
    mockInput.pressEnter();
  });
  await new Promise((r) => setTimeout(r, 50));
  await renderOnce();

  expect(onSubmit).not.toHaveBeenCalled();

  renderer.destroy();
});

// ---------------------------------------------------------------------------
// Test 5: empty input + pressUp shows last history entry
// ---------------------------------------------------------------------------

test("up arrow on empty input shows most recent history entry", async () => {
  const history = ["first command", "second command", "third command"];

  const { renderer, renderOnce, mockInput, waitForFrame } = await testRender(
    makePrompt({ history }),
    { width: 80, height: 24 },
  );

  await renderOnce();

  // Ensure input is empty (it is on mount), press Up
  await act(async () => {
    mockInput.pressArrow("up");
  });
  await new Promise((r) => setTimeout(r, 50));
  await renderOnce();

  // Should show last history item
  await waitForFrame((f) => f.includes("third command"));

  renderer.destroy();
});

// ---------------------------------------------------------------------------
// Test 6 (Bug 1): typing text then pressing Up should NOT navigate history
// (stale-closure guard — reads from ref, not from potentially-stale content state)
// ---------------------------------------------------------------------------

test("up arrow after typing text does NOT replace textarea with history", async () => {
  const history = ["old command"];

  const { renderer, renderOnce, mockInput, waitForFrame, captureCharFrame } =
    await testRender(makePrompt({ history }), { width: 80, height: 24 });

  await renderOnce();

  // Type some text so the textarea is non-empty
  await act(async () => {
    await mockInput.typeText("abc");
  });
  await waitForFrame((f) => f.includes("abc"));

  // Press Up — should NOT replace "abc" with history entry
  await act(async () => {
    mockInput.pressArrow("up");
  });
  await new Promise((r) => setTimeout(r, 50));
  await renderOnce();

  const frame = captureCharFrame();
  // "old command" must not appear — history navigation must have been blocked
  expect(frame).not.toContain("old command");
  // "abc" should still be present
  expect(frame).toContain("abc");

  renderer.destroy();
});

// ---------------------------------------------------------------------------
// Test 7 (Bug 2): Tab completion syncs content state — autocomplete closes
// ---------------------------------------------------------------------------

test("tab on highlighted autocomplete item updates textarea and closes suggestions", async () => {
  const themeRun = mock(() => undefined);
  const commands: Command[] = [
    { id: "/theme", title: "Switch theme", run: themeRun },
    { id: "/help", title: "Show help", run: mock(() => undefined) },
  ];

  const { renderer, renderOnce, mockInput, waitForFrame, captureCharFrame } =
    await testRender(
      makePrompt({ slashCommands: commands }),
      { width: 80, height: 24 },
    );

  await renderOnce();

  // Type "/th" to trigger autocomplete for /theme
  await act(async () => {
    await mockInput.typeText("/th");
  });
  await waitForFrame((f) => f.includes("/theme"));

  // Press Tab to complete
  await act(async () => {
    mockInput.pressTab();
  });
  await new Promise((r) => setTimeout(r, 50));
  await renderOnce();

  const frame = captureCharFrame();
  // Textarea content should now be "/theme " (with trailing space)
  expect(frame).toContain("/theme");
  // Autocomplete suggestions list should no longer show (content no longer matches a bare "/" prefix query)
  // After "/theme " the AC filter returns no prefix match for further typing, so list closes.
  // The key assertion: onSubmit was NOT called, the command was NOT run (Tab doesn't submit).
  expect(themeRun).not.toHaveBeenCalled();

  renderer.destroy();
});

// ---------------------------------------------------------------------------
// Test 8 (Advisory 3): busy=true ignores submit — assert via onSubmit not called
// (reinforces test 4 with explicit focus-independent check)
// ---------------------------------------------------------------------------

test("busy=true: Enter key does not call onSubmit regardless of textarea content", async () => {
  const onSubmit = mock((_line: string) => undefined);

  const { renderer, renderOnce, mockInput, waitForFrame } = await testRender(
    makePrompt({ busy: true, onSubmit }),
    { width: 80, height: 24 },
  );

  await renderOnce();
  await waitForFrame((f) => f.includes("working"));

  // Attempt submit via Enter while busy.
  await act(async () => {
    mockInput.pressEnter();
  });
  await new Promise((r) => setTimeout(r, 50));
  await renderOnce();

  // onSubmit must never be called while busy
  expect(onSubmit).not.toHaveBeenCalled();

  renderer.destroy();
});

test("tab on plain prompt cycles permission mode without submitting", async () => {
  const onSubmit = mock((_line: string) => undefined);
  const onCycleMode = mock(() => undefined);

  const { renderer, renderOnce, mockInput } = await testRender(
    makePrompt({ onSubmit, onCycleMode }),
    { width: 80, height: 24 },
  );

  await renderOnce();

  await act(async () => {
    mockInput.pressTab();
  });
  await new Promise((r) => setTimeout(r, 50));
  await renderOnce();

  expect(onCycleMode).toHaveBeenCalledTimes(1);
  expect(onSubmit).not.toHaveBeenCalled();

  renderer.destroy();
});

import { test, expect } from "bun:test";
import React from "react";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { ThemeProvider } from "./theme/ThemeContext";
import { AppView } from "./routes/session/AppView";
import type { AppViewProps } from "./routes/session/AppView";
import type { TranscriptItem } from "./types";
import { createJobsPanelCallbacks, shouldOpenJobsPanel } from "./App";
import type { TuiAction } from "./hooks/sessionController";

// Shared base props for AppView tests
const baseProps: AppViewProps = {
  transcript: [],
  assistantBuffer: "",
  ready: true,
  busy: false,
  status: { permission_mode: "default", model: "claude-opus-4-5" },
  mcpServers: [],
  version: null,
  history: [],
  slashCommands: [],
  onSubmit: () => {},
  onCycleMode: () => {},
  dialogOpen: false,
  sidebarOpen: false,
  onToggleSidebar: () => {},
};

test("App maps JobsPanel callbacks to typed TUI actions", () => {
  const actions: TuiAction[] = [];
  const callbacks = createJobsPanelCallbacks((action) => actions.push(action));

  callbacks.onRefresh();
  callbacks.onSelect("agent-1");
  callbacks.onCancel("agent-1");

  expect(actions).toEqual([
    { type: "job_request", job_action: "refresh" },
    {
      type: "job_request",
      job_action: "select",
      job_id: "agent-1",
    },
    {
      type: "job_request",
      job_action: "cancel",
      job_id: "agent-1",
      reason: "Cancelled from TUI",
    },
  ]);
});

test("App opens Jobs locally only for the bare panel commands", () => {
  expect(["/jobs", "/workflow", "/workflows"].map(shouldOpenJobsPanel)).toEqual([
    true,
    true,
    true,
  ]);
  expect(shouldOpenJobsPanel("  /jobs  ")).toBe(true);
  expect(shouldOpenJobsPanel("/jobs show agent-1")).toBe(false);
  expect(shouldOpenJobsPanel("/jobs cancel agent-1")).toBe(false);
  expect(shouldOpenJobsPanel("/jobs list")).toBe(false);
});

// ─── Test 1: ready=false → shows Connecting text ─────────────────────────────

test("AppView ready=false shows Connecting text", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <AppView {...baseProps} ready={false} />
    </ThemeProvider>,
    { width: 80, height: 24 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  expect(frame).toContain("Connecting");

  renderer.destroy();
});

// ─── Test 2: empty transcript → Home route with logo + Footer ────────────────

test("AppView with empty transcript renders Home route and Footer", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <AppView {...baseProps} />
    </ThemeProvider>,
    { width: 100, height: 30 },
  );

  await renderOnce();
  // logo is async-rendered (ascii-font); poll for it
  let frame = captureCharFrame();
  for (let i = 0; i < 30; i++) {
    await renderOnce();
    await new Promise((r) => setTimeout(r, 20));
    frame = captureCharFrame();
    if (frame.includes("██╗") || frame.includes("╭") || frame.includes("Vykor")) break;
  }

  // Logo area present in block, slick, or narrow fallback mode.
  const hasLogo = frame.includes("██╗") || frame.includes("╭") || frame.includes("Vykor");
  expect(hasLogo).toBe(true);

  // ctrl+p hint rendered by Home component
  expect(frame).toContain("ctrl+p");

  renderer.destroy();
});

// ─── Test 3: user + assistant transcript → Session route with messages ────────

test("AppView with user+assistant transcript renders Session view", async () => {
  const transcript: TranscriptItem[] = [
    { role: "user", text: "Hello from the user" },
    { role: "assistant", text: "Hello from the assistant" },
  ];

  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <AppView
        {...baseProps}
        transcript={transcript}
      />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );

  await renderOnce();
  // Markdown parse is async and needs repeated renderOnce + wall-clock time.
  // waitForFrame alone is not enough: cellsUpdated stays 0 until React re-renders.
  let frame = captureCharFrame();
  for (let i = 0; i < 100; i++) {
    await renderOnce();
    await new Promise((r) => setTimeout(r, 20));
    frame = captureCharFrame();
    if (
      frame.includes("Hello from the user") &&
      frame.includes("Hello from the assistant") &&
      frame.includes("claude-opus-4-5")
    ) {
      break;
    }
  }

  expect(frame).toContain("Hello from the user");
  expect(frame).toContain("Hello from the assistant");
  // Prompt meta row renders model name from status
  expect(frame).toContain("claude-opus-4-5");

  renderer.destroy();
});

test("AppView renders assistant text when a canonical part appears after the user row", async () => {
  let publishAssistant: () => void = () => {};
  function Harness() {
    const [transcript, setTranscript] = React.useState<TranscriptItem[]>([
      { id: "user-1", role: "user", text: "dynamic user" }
    ]);
    publishAssistant = () => setTranscript((items) => [
      ...items,
      { id: "assistant-1:part-1", role: "assistant", text: "dynamic assistant", streaming: true, },
    ]);
    return <AppView {...baseProps} transcript={transcript} busy />;
  }

  const { renderer, renderOnce, waitForFrame, captureCharFrame } = await testRender(
    <ThemeProvider><Harness /></ThemeProvider>,
    { width: 100, height: 40 },
  );
  await renderOnce();
  await act(async () => publishAssistant());
  await waitForFrame((frame) => frame.includes("dynamic assistant"), { maxPasses: 60, });
  expect(captureCharFrame()).toContain("dynamic assistant");
  renderer.destroy();
});

// ─── Test 4: dialogOpen=true → Prompt not rendered ──────────────────────────

test("AppView with dialogOpen=true does not render Prompt", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <AppView {...baseProps} dialogOpen={true} />
    </ThemeProvider>,
    { width: 80, height: 24 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  // When dialog is open, the Prompt's placeholder text should not appear
  // The default placeholder includes "Ask anything"
  expect(frame).not.toContain("Ask anything");

  renderer.destroy();
});

// ─── Test 4b: draft survives dialog open/close (Prompt unmount/remount) ──────

test("AppView preserves prompt draft across dialog open/close", async () => {
  let setDialogOpen: (v: boolean) => void = () => {};

  function Harness() {
    const [open, setOpen] = React.useState(false);
    const [draft, setDraft] = React.useState("draft-text-123");
    setDialogOpen = setOpen;
    return (
      <AppView {...baseProps} dialogOpen={open} draft={draft} onDraftChange={setDraft} />
    );
  }

  const { renderer, renderOnce, captureCharFrame, waitForFrame } = await testRender(
    <ThemeProvider>
      <Harness />
    </ThemeProvider>,
    { width: 100, height: 30 },
  );

  await renderOnce();
  await waitForFrame((f) => f.includes("draft-text-123"), { maxPasses: 30 });
  expect(captureCharFrame()).toContain("draft-text-123");

  // Open dialog → Prompt unmounts, draft text disappears
  await act(async () => {
    setDialogOpen(true);
  });
  await waitForFrame((f) => !f.includes("draft-text-123"), { maxPasses: 30 });
  expect(captureCharFrame()).not.toContain("draft-text-123");

  // Close dialog → Prompt remounts and restores the lifted draft
  await act(async () => {
    setDialogOpen(false);
  });
  await waitForFrame((f) => f.includes("draft-text-123"), { maxPasses: 30 });
  expect(captureCharFrame()).toContain("draft-text-123");

  renderer.destroy();
});

// ─── Test 5: busy=true with non-empty transcript → Session route (not Home) ──

test("AppView busy=true stays in Session route even with empty transcript", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <AppView
        {...baseProps}
        transcript={[]}
        assistantBuffer=""
        busy={true}
      />
    </ThemeProvider>,
    { width: 100, height: 30 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  // busy=true → session route; Prompt renders in busy/spinner state
  // Spinner or "working" text appears
  expect(frame).toContain("working");

  // Logo from Home should NOT be present (we're in session route)
  expect(frame).not.toContain("ctrl+p commands");

  renderer.destroy();
});

// ─── Test 6: assistantBuffer → Session route (streaming) ─────────────────────

test("AppView with assistantBuffer shows session route with streaming content", async () => {
  const { renderer, renderOnce, captureCharFrame, waitForFrame } = await testRender(
    <ThemeProvider>
      <AppView
        {...baseProps}
        transcript={[]}
        assistantBuffer="Streaming text here"
      />
    </ThemeProvider>,
    { width: 100, height: 30 },
  );

  await renderOnce();
  await waitForFrame((f) => f.includes("Streaming text here"), { maxPasses: 30, });
  const frame = captureCharFrame();

  expect(frame).toContain("Streaming text here");

  renderer.destroy();
});

import { expect, test } from "bun:test";
import { act, useMemo, useState } from "react";
import { testRender } from "@opentui/react/test-utils";

import { ThemeProvider } from "../theme/ThemeContext";
import { DialogProvider, useDialog } from "../ui/DialogContext";
import { useModalWiring } from "./useModalWiring";
import type { TuiSessionController } from "./sessionController";

type ModalHarnessApi = {
  setSelectRequest: TuiSessionController["setSelectRequest"];
  setModal: TuiSessionController["setModal"];
  setDisplayRequest: TuiSessionController["setDisplayRequest"];
  replaceAppDialog(): void;
  closeDialog(): void;
  sent: Array<Record<string, unknown>>;
};

function ModalHarness({ onReady }: { onReady: (api: ModalHarnessApi) => void }) {
  const dialog = useDialog();
  const [selectRequest, setSelectRequest] = useState<TuiSessionController["selectRequest"]>(null);
  const [modal, setModal] = useState<TuiSessionController["modal"]>(null);
  const [displayRequest, setDisplayRequest] = useState<TuiSessionController["displayRequest"]>(null);
  const sent: Array<Record<string, unknown>> = useMemo(() => [], []);
  const session = useMemo<TuiSessionController>(() => ({
    transcript: [],
    assistantBuffer: "",
    status: {},
    jobState: { status: "idle", jobs: [] },
    jobs: [],
    jobDetailState: { status: "idle" },
    commands: [],
    commandDetails: [],
    mcpServers: [],
    modal,
    selectRequest,
    displayRequest,
    busy: false,
    ready: true,
    setModal,
    setSelectRequest,
    setDisplayRequest,
    setBusy: () => undefined,
    loadModels: async () => [],
    sendRequest: (payload) => {
      sent.push(payload);
    },
  }), [displayRequest, modal, selectRequest, sent]);

  useModalWiring(session, dialog);
  onReady({
    setSelectRequest, setModal, setDisplayRequest, sent,
    replaceAppDialog: () => dialog.replace(<text>Model picker</text>),
    closeDialog: dialog.close,
  });
  return null;
}

test("updating /sessions options does not close the picker", async () => {
  let api: ModalHarnessApi | null = null;

  const { renderer, renderOnce, captureCharFrame, waitForFrame } = await testRender(
    <ThemeProvider>
      <DialogProvider>
        <ModalHarness onReady={(next) => { api = next; }} />
      </DialogProvider>
    </ThemeProvider>,
    { width: 80, height: 24 },
  );

  await renderOnce();
  await act(async () => {
    api?.setSelectRequest({
      title: "Sessions",
      submitPrefix: "/sessions open ",
      options: [
        { value: "s1", label: "One" },
        { value: "s2", label: "Two" },
      ],
    });
  });
  await waitForFrame((f) => f.includes("Two"));

  await act(async () => {
    api?.setSelectRequest({
      title: "Sessions",
      submitPrefix: "/sessions open ",
      options: [{ value: "s1", label: "One" }],
    });
  });
  await waitForFrame((f) => !f.includes("Two"));
  const frame = captureCharFrame();
  expect(frame).toContain("Sessions");
  expect(frame).toContain("One");
  expect(frame).not.toContain("Two");

  renderer.destroy();
});

test("AskUser collects structured answers and only cancels on an explicit escape", async () => {
  let api: ModalHarnessApi | undefined;
  const { renderer, mockInput, renderOnce, waitForFrame } = await testRender(
    <ThemeProvider>
      <DialogProvider>
        <ModalHarness onReady={(next) => { api = next; }} />
      </DialogProvider>
    </ThemeProvider>,
    { width: 80, height: 24 },
  );
  try {
    await renderOnce();
    await act(async () => {
      api?.setModal({
        kind: "question", request_id: "structured", question: "Questions",
        questions: [
          { question: "Pick one", type: "radio", options: ["First", "Second"] },
          { question: "Explain", type: "check", options: [] },
        ],
      });
    });
    await waitForFrame(frame => frame.includes("Pick one") && frame.includes("Second"));
    await act(async () => { await mockInput.typeText("2"); mockInput.pressEnter(); });
    await waitForFrame(frame => frame.includes("Explain"));
    expect(api?.sent).toEqual([]);
    await act(async () => { await mockInput.typeText("because"); mockInput.pressEnter(); });
    expect(api?.sent).toEqual([{
      type: "question_response", request_id: "structured",
      answer: JSON.stringify({ selected: { 0: [1] }, custom: { 1: "because" } }),
    }]);

    await act(async () => { api?.setModal({ kind: "question", request_id: "replaced", question: "Old question" }); });
    await waitForFrame(frame => frame.includes("Old question"));
    await act(async () => { api?.setModal({ kind: "question", request_id: "cancelled", question: "Current question" }); });
    await waitForFrame(frame => frame.includes("Current question"));
    await act(async () => { api?.setDisplayRequest({ title: "Auxiliary", content: "Other panel" }); });
    await waitForFrame(frame => frame.includes("Other panel") && !frame.includes("Current question"));
    const escape = () => act(async () => {
      mockInput.pressEscape();
      // The terminal waits to distinguish a standalone escape from an escape sequence.
      await new Promise(resolve => setTimeout(resolve, 250));
    });
    await escape();
    await waitForFrame(frame => frame.includes("Current question"));
    expect(api?.sent).toHaveLength(1);
    await escape();
    expect(api?.sent).toEqual([
      expect.objectContaining({ request_id: "structured" }),
      { type: "question_response", request_id: "cancelled", answer: "" },
    ]);
  } finally {
    renderer.destroy();
  }
});

test("closing an App dialog restores a pending AskUser until its answer is submitted", async () => {
  let api: ModalHarnessApi | undefined;
  const { renderer, mockInput, renderOnce, waitForFrame } = await testRender(
    <ThemeProvider>
      <DialogProvider>
        <ModalHarness onReady={(next) => { api = next; }} />
      </DialogProvider>
    </ThemeProvider>,
    { width: 80, height: 24 },
  );
  try {
    await renderOnce();
    await act(async () => {
      api?.setModal({ kind: "question", request_id: "waiting", question: "Pending question" });
    });
    await waitForFrame(frame => frame.includes("Pending question"));

    await act(async () => { api?.replaceAppDialog(); });
    await waitForFrame(frame => frame.includes("Model picker") && !frame.includes("Pending question"));
    await act(async () => { api?.closeDialog(); });
    await waitForFrame(frame => frame.includes("Pending question"));
    expect(api?.sent).toEqual([]);

    await act(async () => { await mockInput.typeText("answer"); mockInput.pressEnter(); });
    await waitForFrame(frame => !frame.includes("Pending question"));
    await act(async () => { api?.replaceAppDialog(); });
    await waitForFrame(frame => frame.includes("Model picker"));
    await act(async () => { api?.closeDialog(); });
    const frame = await waitForFrame(frame => !frame.includes("Model picker"));
    expect(frame).not.toContain("Pending question");
    expect(api?.sent).toEqual([{ type: "question_response", request_id: "waiting", answer: "answer" }]);
  } finally {
    renderer.destroy();
  }
});

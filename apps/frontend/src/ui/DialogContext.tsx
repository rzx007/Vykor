import type { UiNode } from "../types/ui";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useTheme } from "../theme/ThemeContext";

type DialogOnClose = (reason?: "escape") => void;
type DialogEntry = { node: UiNode; onClose?: DialogOnClose };

export type DialogApi = {
  push: (node: UiNode, onClose?: DialogOnClose) => void;
  /** Close the whole stack and push a new entry (for mutually exclusive dialogs like command palette). */
  replace: (node: UiNode, onClose?: DialogOnClose) => void;
  /** Update the top dialog node without firing onClose. Use this to refresh items in-place. */
  update: (node: UiNode) => void;
  close: () => void;
  closeAll: () => void;
  isOpen: boolean;
};

const DialogContext = createContext<DialogApi>({
  push: () => undefined,
  replace: () => undefined,
  update: () => undefined,
  close: () => undefined,
  closeAll: () => undefined,
  isOpen: false,
});

export function useDialog(): DialogApi {
  return useContext(DialogContext);
}

export function DialogProvider({
  children,
}: {
  children: UiNode;
}) {
  const [stack, setStack] = useState<DialogEntry[]>([]);
  // Ref for stack length to avoid stale closure in useKeyboard handler
  const stackLenRef = useRef(0);
  stackLenRef.current = stack.length;
  const { theme } = useTheme();
  const { width, height } = useTerminalDimensions();

  const push = useCallback(
    (node: UiNode, onClose?: DialogOnClose) => {
      setStack((prev) => [...prev, { node, onClose }]);
    },
    [],
  );

  const replace = useCallback(
    (node: UiNode, onClose?: DialogOnClose) => {
      setStack((prev) => {
        // Call onClose for all existing entries being removed
        for (const entry of prev) {
          entry.onClose?.();
        }
        return [{ node, onClose }];
      });
    },
    [],
  );

  const update = useCallback((node: UiNode) => {
    setStack((prev) => {
      if (prev.length === 0) return prev;
      const top = prev[prev.length - 1]!;
      return [...prev.slice(0, -1), { ...top, node }];
    });
  }, []);

  const closeTop = useCallback((reason?: "escape") => {
    setStack((prev) => {
      if (prev.length === 0) return prev;
      const top = prev[prev.length - 1]!;
      if (reason) top.onClose?.(reason);
      else top.onClose?.();
      return prev.slice(0, -1);
    });
  }, []);
  const close = useCallback(() => closeTop(), [closeTop]);

  const closeAll = useCallback(() => {
    setStack((prev) => {
      for (const entry of prev) {
        entry.onClose?.();
      }
      return [];
    });
  }, []);

  // Fallback ESC handler — only consume when stack is non-empty.
  // Uses a ref to avoid stale closure (stack.length captured at registration time).
  useKeyboard((key) => {
    if (key.name === "escape" && stackLenRef.current > 0) {
      closeTop("escape");
    }
  });

  const isOpen = stack.length > 0;
  const topEntry = stack.length > 0 ? (stack[stack.length - 1] ?? null) : null;

  // Compute dialog box dimensions
  const dialogWidth = Math.min(64, Math.max(40, Math.floor(width * 0.6)));
  const dialogTop = Math.max(1, Math.floor(height / 4));
  const dialogLeft = Math.max(0, Math.floor((width - dialogWidth) / 2));

  const api = useMemo<DialogApi>(
    () => ({ push, replace, update, close, closeAll, isOpen }),
    [push, replace, update, close, closeAll, isOpen],
  );

  return (
    <DialogContext.Provider value={api}>
      <box position="relative" width="100%" height="100%">
        {children}
        {topEntry !== null && (
          <box
            position="absolute"
            top={dialogTop}
            left={dialogLeft}
            width={dialogWidth}
            zIndex={100}
            border={true}
            borderColor={theme.colors.accent}
            backgroundColor={theme.colors.backgroundPanel}
            padding={1}
            flexDirection="column"
          >
            {topEntry.node}
          </box>
        )}
      </box>
    </DialogContext.Provider>
  );
}

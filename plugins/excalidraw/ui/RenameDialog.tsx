import { useEffect, useRef, useState } from "react";
import type { Translate } from "#ui/DocumentMenu.tsx";

export function RenameDialog({
  title,
  onSave,
  onClose,
  t,
}: {
  title: string;
  onSave(title: string): Promise<void>;
  onClose(): void;
  t: Translate;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const [value, setValue] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    input.current?.select();
  }, []);
  const submit = async () => {
    if (pending.current || !input.current?.reportValidity()) return;
    const title = value.trim();
    if (!title || title.length > 200) { setError(t("画板名称需要 1–200 个字符。", "Use 1 to 200 characters for the diagram name.")); return; }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await onSave(title);
      dialog.current?.close();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="panel-dialog text-ui-base"
      aria-labelledby="rename-title"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter" && !event.nativeEvent.isComposing && event.target === input.current) {
          event.preventDefault(); void submit();
        }
      }}
      onCancel={(event) => {
        if (pending.current) event.preventDefault();
      }}
      onClose={onClose}
    >
      <div className="dialog-fields">
        <h2 id="rename-title" className="text-ui-base">
          {t("重命名画板", "Rename diagram")}
        </h2>
        <label htmlFor="rename-input">{t("画板名称", "Diagram name")}</label>
        <input
          ref={input}
          id="rename-input"
          autoFocus
          required
          maxLength={200}
          disabled={busy}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        {error && (
          <p className="dialog-error text-ui-sm" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={() => { if (!pending.current) dialog.current?.close(); }}>
            {t("取消", "Cancel")}
          </button>
          <button id="rename-button" type="button" className="primary-button" disabled={busy || !value.trim()} onClick={() => void submit()}>
            {busy ? t("保存中…", "Saving…") : t("保存", "Save")}
          </button>
        </div>
      </div>
    </dialog>
  );
}

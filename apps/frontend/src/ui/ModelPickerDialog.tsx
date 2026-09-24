import { useEffect, useMemo, useRef, useState } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { ModelInfo, ModelProviderInfo } from "@vykor/client";

import { useTheme } from "../theme/ThemeContext";
import { AC_VISIBLE_ITEMS } from "./constants";

type Row =
  | { kind: "spacer"; key: string }
  | { kind: "provider"; key: string; label: string }
  | { kind: "model"; key: string; provider: ModelProviderInfo; model: ModelInfo };

const SCROLLBOX_CHROME_ROWS = 4;
const MODEL_LIST_HEIGHT = AC_VISIBLE_ITEMS + SCROLLBOX_CHROME_ROWS;

function matches(value: string, query: string): boolean {
  return value.toLowerCase().includes(query.toLowerCase());
}

function modelSearchText(provider: ModelProviderInfo, model: ModelInfo): string {
  return [
    provider.displayName,
    provider.name,
    model.label,
    model.id,
    model.hint ?? "",
  ].join(" ");
}

function buildRows(providers: ModelProviderInfo[], query: string): Row[] {
  const rows: Row[] = [];
  for (const provider of providers) {
    const providerMatches = matches(`${provider.displayName} ${provider.name}`, query);
    const models = query
      ? provider.models.filter((model) => providerMatches || matches(modelSearchText(provider, model), query))
      : provider.models;
    if (models.length === 0) continue;
    if (rows.length > 0) rows.push({ kind: "spacer", key: `spacer:${provider.name}` });
    rows.push({ kind: "provider", key: `provider:${provider.name}`, label: provider.displayName });
    for (const model of models) {
      rows.push({ kind: "model", key: `model:${provider.name}:${model.id}`, provider, model });
    }
  }
  return rows;
}

function closestModelIndex(rows: Row[], currentModel?: string): number {
  const exact = rows.findIndex((row) => row.kind === "model" && row.model.id === currentModel);
  if (exact >= 0) return exact;
  return rows.findIndex((row) => row.kind === "model");
}

function nextModelIndex(rows: Row[], current: number, direction: 1 | -1): number {
  if (rows.length === 0) return -1;
  let index = current;
  for (let step = 0; step < rows.length; step += 1) {
    index = (index + direction + rows.length) % rows.length;
    if (rows[index]?.kind === "model") return index;
  }
  return -1;
}

export function ModelPickerDialog(props: {
  providers: ModelProviderInfo[];
  currentModel?: string;
  onSelect(model: ModelInfo): void;
}) {
  const { providers, currentModel, onSelect } = props;
  const { theme } = useTheme();
  const [query, setQuery] = useState("");
  const rows = useMemo(() => buildRows(providers, query.trim()), [providers, query]);
  const [selectedIndex, setSelectedIndex] = useState(() => closestModelIndex(rows, currentModel));
  const mountedRef = useRef(false);
  const listRef = useRef<ScrollBoxRenderable | null>(null);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    setSelectedIndex(closestModelIndex(rows, currentModel));
  }, [currentModel, rows]);

  useEffect(() => {
    if (selectedIndex < 0) return;
    listRef.current?.scrollChildIntoView(`model-picker-row-${selectedIndex}`);
  }, [selectedIndex, rows]);

  useKeyboard((key) => {
    if (rows.length === 0) return;
    if (key.name === "up") {
      setSelectedIndex((index) => nextModelIndex(rows, index, -1));
      return;
    }
    if (key.name === "down") {
      setSelectedIndex((index) => nextModelIndex(rows, index, 1));
      return;
    }
    if (key.name === "return") {
      const row = rows[selectedIndex];
      if (row?.kind === "model") onSelect(row.model);
      return;
    }
    if (key.name === "pageup") {
      listRef.current?.scrollBy(-1, "viewport");
      return;
    }
    if (key.name === "pagedown") {
      listRef.current?.scrollBy(1, "viewport");
    }
  });

  const isScrollable = rows.length > AC_VISIBLE_ITEMS;
  const listHeight = MODEL_LIST_HEIGHT;

  const rowNodes = rows.map((row, index) => {
    if (row.kind === "spacer") {
      return (
        <box
          key={row.key}
          id={`model-picker-row-${index}`}
          width="100%"
          height={1}
          flexShrink={0}
        />
      );
    }

    if (row.kind === "provider") {
      return (
        <box
          key={row.key}
          id={`model-picker-row-${index}`}
          flexDirection="row"
          width="100%"
          height={1}
          flexShrink={0}
        >
          <text attributes={TextAttributes.BOLD} fg={theme.colors.accent}>
            {row.label}
          </text>
        </box>
      );
    }

    const isSelected = index === selectedIndex;
    const isCurrent = row.model.id === currentModel;
    return (
      <box
        key={row.key}
        id={`model-picker-row-${index}`}
        flexDirection="row"
        width="100%"
        paddingLeft={1}
        height={1}
        flexShrink={0}
        backgroundColor={isSelected ? theme.colors.accent : undefined}
        onMouseUp={() => {
          setSelectedIndex(index);
          onSelect(row.model);
        }}
      >
        <text
          attributes={isCurrent ? TextAttributes.BOLD : undefined}
          fg={isSelected ? theme.colors.background : theme.colors.foreground}
        >
          {row.model.label}
        </text>
        <box flexGrow={1} />
        {row.model.hint ? (
          <text fg={isSelected ? theme.colors.background : theme.colors.muted}>
            {row.model.hint}
          </text>
        ) : null}
      </box>
    );
  });

  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="row" paddingBottom={1}>
        <text attributes={TextAttributes.BOLD} fg={theme.colors.accent}>Select model</text>
        <box flexGrow={1} />
        <text fg={theme.colors.muted}>   esc</text>
      </box>

      <input
        focused
        placeholder="Search"
        onInput={(value: string) => setQuery(value)}
      />

      {rows.length === 0 ? (
        <text fg={theme.colors.muted}>No connected providers.</text>
      ) : !isScrollable ? (
        <box flexDirection="column" width="100%">
          {rowNodes}
        </box>
      ) : (
        <scrollbox
          ref={listRef}
          scrollY
          width="100%"
          height={listHeight}
          flexDirection="column"
          viewportCulling={false}
          horizontalScrollbarOptions={{ visible: false }}
        >
          {rowNodes}
        </scrollbox>
      )}

      <box flexDirection="row" paddingTop={1}>
        <text fg={theme.colors.foreground}>Connect provider </text>
        <text fg={theme.colors.muted}>ctrl+a  </text>
        <text fg={theme.colors.foreground}>Favorite </text>
        <text fg={theme.colors.muted}>ctrl+f</text>
      </box>
    </box>
  );
}

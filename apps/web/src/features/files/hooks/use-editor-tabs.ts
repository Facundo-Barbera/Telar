"use client";

import { useCallback, useRef, useState } from "react";
import { closeEditorFile, editorFileForPath, openInEditor, type EditorState, type EditorViewState, type OpenIntent } from "../editor-workspace";
import { discardDraft } from "../editor-drafts";

export type SaveState = "saving" | "problem";

export function useEditorTabs({
  onState,
  enabledPlugins,
  scope,
}: {
  onState: (next: (current: EditorState) => EditorState) => void;
  enabledPlugins: readonly string[];
  scope: string;
}) {
  const views = useRef(new Map<string, EditorViewState>());
  const [saving, setSaving] = useState<ReadonlyMap<string, SaveState>>(new Map());
  const [confirming, setConfirming] = useState<string>();
  const closed = useRef(new Set<string>());
  const closingWhenClean = useRef(new Set<string>());

  const openFile = useCallback(
    (path: string, intent: OpenIntent) => {
      closed.current.delete(path);
      closingWhenClean.current.delete(path);
      onState((current) => openInEditor(current, editorFileForPath(path, enabledPlugins), intent));
    },
    [onState, enabledPlugins],
  );

  const forget = useCallback(
    (path: string) => {
      setConfirming((current) => (current === path ? undefined : current));
      views.current.delete(path);
      closingWhenClean.current.delete(path);
      closed.current.add(path);
      setSaving((current) => {
        if (!current.has(path)) return current;
        const next = new Map(current);
        next.delete(path);
        return next;
      });
      onState((current) => closeEditorFile(current, path));
    },
    [onState],
  );

  const close = useCallback(
    (path: string) => {
      const status = saving.get(path);
      if (status === "problem") {
        if (confirming !== path) {
          setConfirming(path);
          return;
        }
        discardDraft(scope, path);
        forget(path);
        return;
      }
      if (status === "saving") {
        closingWhenClean.current.add(path);
        return;
      }
      forget(path);
    },
    [saving, confirming, forget, scope],
  );

  const closeMany = useCallback((paths: readonly string[]) => paths.forEach((path) => close(path)), [close]);

  const reportSave = useCallback(
    (path: string, next: "clean" | SaveState) => {
      if (closed.current.has(path)) return;
      if (next === "clean" && closingWhenClean.current.has(path)) {
        forget(path);
        return;
      }
      if (next === "problem" && closingWhenClean.current.delete(path)) setConfirming(path);
      setSaving((current) => {
        if (next === "clean" ? !current.has(path) : current.get(path) === next) return current;
        const updated = new Map(current);
        if (next === "clean") updated.delete(path);
        else updated.set(path, next);
        return updated;
      });
    },
    [forget],
  );

  const cancelConfirm = useCallback((path: string) => setConfirming((current) => (current === path ? undefined : current)), []);

  return { views, saving, confirming, openFile, close, closeMany, reportSave, cancelConfirm };
}

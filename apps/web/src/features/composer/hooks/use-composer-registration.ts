"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { flushSync } from "react-dom";
import { registerComposer, type ComposerKind, type ComposerSubmit } from "../registry";
import type { ComposerEditorHandle } from "../components/composer-editor";

const NOT_READY = { ok: false as const, reason: "This conversation is not ready yet." };
const OFF_SCREEN = { ok: false as const, reason: "The message box is not on screen." };

/** Registers this composer for the page API and dictation, which call in from outside React. */
export function useComposerRegistration(
  token: string,
  editorId: string,
  kind: ComposerKind,
  editor: RefObject<ComposerEditorHandle | null>,
  current: { text: string; ready: boolean; submit: () => ComposerSubmit },
) {
  // A layout effect: `dictate(text, { submit: true })` sends in the same breath and must see the inserted draft.
  const live = useRef(current);
  useLayoutEffect(() => {
    live.current = current;
  });

  useEffect(() => {
    // Flushed so a caller outside React reads the committed draft back synchronously.
    const write = (edit: (box: ComposerEditorHandle) => string) => {
      if (!live.current.ready) return NOT_READY;
      const box = editor.current;
      if (!box) return OFF_SCREEN;
      let draft = "";
      flushSync(() => {
        draft = edit(box);
      });
      return { ok: true as const, draft };
    };
    return registerComposer(token, {
      id: editorId,
      kind,
      draft: () => live.current.text,
      focused: () => editor.current?.focused() ?? false,
      insert: (text) => write((box) => box.insertAtCaret(text)),
      replace: (start, end, text) => write((box) => box.replaceRange(start, end, text)),
      dictating: (state) => editor.current?.dictating(state),
      caretRect: () => editor.current?.caretRect(),
      submit: () => live.current.submit(),
    });
  }, [token, editorId, kind, editor]);
}

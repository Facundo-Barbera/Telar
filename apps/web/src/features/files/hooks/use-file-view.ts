import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { EditorViewState } from "@/lib/editor-workspace";
import { carryTokens, highlight, type HighlightedLine } from "@/lib/highlight";

const HIGHLIGHT_DELAY_MS = 120;

/** Plain lines at once, colours a beat later; unchanged lines keep their tokens while typing. */
export function useHighlightedLines(draft: string | undefined, lang: string | undefined) {
  const [tokenised, setTokenised] = useState<{ of: string; lines: HighlightedLine[] }>();
  const lines = useMemo(() => (draft === undefined ? [] : draft.split("\n")), [draft]);
  useEffect(() => {
    if (draft === undefined) return;
    let cancelled = false;
    const task = window.setTimeout(() => {
      void highlight(draft, lang).then((result) => {
        if (!cancelled && result) setTokenised({ of: draft, lines: result });
      });
    }, HIGHLIGHT_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(task);
    };
  }, [draft, lang]);
  const coloured = useMemo(() => (tokenised && draft !== undefined ? carryTokens(tokenised, draft) : undefined), [tokenised, draft]);
  return { lines, coloured };
}

/** Puts caret and scroll back once the text lands, and returns the callback that records them. */
export function useRestoredView(
  draft: string | undefined,
  readView: RefObject<(() => EditorViewState | undefined) | undefined>,
  onView: ((view: EditorViewState) => void) | undefined,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  scrollerRef: RefObject<HTMLDivElement | null>,
) {
  const restored = useRef(false);
  useEffect(() => {
    if (draft === undefined || restored.current) return;
    const where = readView.current?.();
    if (!where) {
      restored.current = true;
      return;
    }
    const frame = requestAnimationFrame(() => {
      const area = textareaRef.current;
      const scroller = scrollerRef.current;
      // Latched when it lands: a re-run cancels the frame, and an earlier latch would skip the restore for good.
      restored.current = true;
      if (area) area.setSelectionRange(Math.min(where.selectionStart, area.value.length), Math.min(where.selectionEnd, area.value.length));
      if (scroller) {
        scroller.scrollTop = where.scrollTop;
        scroller.scrollLeft = where.scrollLeft;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [draft, readView, textareaRef, scrollerRef]);

  return useCallback(() => {
    const area = textareaRef.current;
    if (!area || !onView) return;
    onView({
      selectionStart: area.selectionStart,
      selectionEnd: area.selectionEnd,
      scrollTop: scrollerRef.current?.scrollTop ?? 0,
      scrollLeft: scrollerRef.current?.scrollLeft ?? 0,
    });
  }, [onView, textareaRef, scrollerRef]);
}

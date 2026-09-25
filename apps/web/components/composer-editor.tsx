"use client";

/**
 * THE BOX YOU TYPE INTO, WHICH CAN ALSO HOLD CHIPS.
 *
 * This replaces the composer's `<textarea>`, and the reason is the only reason
 * that would justify it: a textarea can hold one typeface and no objects. A
 * message that says "fix the failing check in `apps/engine/src/driver.ts`" is
 * mostly prose with two ADDRESSES in it, and an address wants a glyph and a
 * short name rather than forty characters of path spelled out mid-sentence.
 *
 * ══ THE ONE RULE ══
 * THE DRAFT IS A STRING, AND THE CHIPS ARE A DRAWING OF IT. `serialize()` walks
 * this element and returns exactly the text that will be sent; a chip
 * contributes the reference text it stands for, character for character. There
 * is no side table of "attachments" resolved at send time, so there is no way
 * for the box to show one thing and the agent to receive another. Everything
 * below exists to keep that true while a browser edits the DOM underneath us.
 *
 * ══ WHY IT IS IMPERATIVE, AND NOT REACT ══
 * React owns nothing inside this element — it is rendered with no children and
 * filled by `paint()`. That is not a shortcut, it is the requirement: a
 * `contentEditable` is mutated by the browser on every keystroke, and a React
 * subtree that is edited from underneath reconciles against a DOM it no longer
 * describes. Two consequences worth stating rather than discovering:
 *
 *   - TYPING DOES NOT REPAINT. `onInput` reads the DOM and reports the string;
 *     it does not write the DOM back. That is what keeps the caret where the
 *     user put it and the browser's own undo stack intact.
 *   - A REPAINT IS ALWAYS A GESTURE — accepting a completion, dropping a row,
 *     pasting, or the parent replacing the whole draft. Those are the moments a
 *     chip can appear, and the only moments the caret is placed by us.
 *
 * ══ WHERE THIS DEPARTS FROM t3 code ══
 * The donor builds the same thing on Lexical, with a decorator node per chip
 * and six plugins to teach Lexical's selection model how to step over one. We
 * do not take that dependency: a chip here is an inline `contenteditable=false`
 * span, which Chromium — the only engine this cockpit runs in, being Electron
 * and Chrome — already treats as a single character for arrow keys, selection
 * and backspace. What is left is the offset arithmetic below, which Lexical
 * would have needed anyway to answer "what is the caret's index in the string".
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { CHIP_CLASS, CHIP_ICON_CLASS, CHIP_LABEL_CLASS, chipTitle } from "@/lib/composer-chip";
import { replaceTextRange, segmentDraft } from "@/lib/composer-tokens";
import { insertReference, type TelarReference } from "@/lib/drag-reference";
import { chipGlyphFor, glyphElement } from "@/lib/glyph-paths";
import { cn } from "@/lib/utils";

/**
 * One chip.
 *
 * THE LOOK MOVED TO `lib/composer-chip.ts` and is now shared with the
 * transcript, which draws the same chips in React once a message is sent (see
 * `components/session/prompt-text.tsx`). Two mechanisms — this one builds DOM
 * because a `contenteditable` needs nodes a caret can stand between — and they
 * must not be two appearances.
 *
 * `data-chip-text` IS THE SERIALIZATION. Everything else in this element is
 * decoration — the glyph, the shortened label, the tooltip — and none of it is
 * ever read back. A reader looking for "what does this chip send" needs to look
 * at exactly one attribute.
 */
function chipElement(reference: TelarReference): HTMLElement {
  const chip = document.createElement("span");
  chip.className = CHIP_CLASS;
  chip.contentEditable = "false";
  chip.spellcheck = false;
  chip.dataset.chipText = reference.text;
  chip.dataset.chipKind = reference.kind;
  chip.title = chipTitle(reference);

  const { markup, tint } = chipGlyphFor(reference);
  chip.append(glyphElement(markup, cn(CHIP_ICON_CLASS, tint)));

  const label = document.createElement("span");
  label.className = CHIP_LABEL_CLASS;
  label.textContent = reference.label;
  chip.append(label);
  return chip;
}

/**
 * THE WORDS STILL BEING REVISED, DRAWN DIMMER (#561).
 *
 * A plain `<span>` with an attribute and no `data-chip-text`, which is what
 * makes it free: `textOf` recurses into any element it does not recognise and
 * returns its text, so the draft serializes identically whether this wrapper is
 * there or not. The ONE RULE at the top of this file is not bent — this is a
 * drawing of the same string.
 *
 * AND THE ATTRIBUTE IS WHAT PAINTS IT, not a class the dictation reaches in and
 * toggles. The span is created and destroyed by `paint` like every other node
 * here, so there is nothing left behind for `serialize` to trip over when a
 * phrase settles.
 */
const INTERIM_ATTRIBUTE = "data-dictation-interim";
const INTERIM_CLASS = "opacity-55";

/** The part of `[from, to)` that falls inside a segment starting at `at`. */
function overlap(at: number, length: number, run: { start: number; end: number }): { from: number; to: number } | undefined {
  const from = Math.max(run.start - at, 0);
  const to = Math.min(run.end - at, length);
  return from < to ? { from, to } : undefined;
}

function dimmed(text: string): HTMLElement {
  const span = document.createElement("span");
  span.setAttribute(INTERIM_ATTRIBUTE, "");
  span.className = INTERIM_CLASS;
  span.textContent = text;
  return span;
}

/**
 * Draw a whole draft.
 *
 * THE TRAILING EMPTY TEXT NODE IS LOAD-BEARING. A `contenteditable=false`
 * span as the last child leaves the caret nowhere to stand after it, so the
 * browser refuses to put one there and typing at the end of the message goes
 * nowhere. An empty text node after it is a legal caret position that
 * serializes to nothing.
 *
 * `interim` IS A RUN OF DRAFT OFFSETS, or nothing. A text segment it crosses is
 * cut into up to three nodes so the dimmed one covers exactly the run — a chip
 * is never dimmed, because a chip is not a word anybody dictated.
 */
function paint(root: HTMLElement, draft: string, interim?: { start: number; end: number }): void {
  const nodes: Node[] = [];
  let at = 0;
  for (const segment of segmentDraft(draft)) {
    if (segment.type !== "text") {
      nodes.push(chipElement(segment.reference));
      at += segment.reference.text.length;
      continue;
    }
    const inside = interim ? overlap(at, segment.text.length, interim) : undefined;
    if (!inside) {
      nodes.push(document.createTextNode(segment.text));
    } else {
      if (inside.from > 0) nodes.push(document.createTextNode(segment.text.slice(0, inside.from)));
      nodes.push(dimmed(segment.text.slice(inside.from, inside.to)));
      if (inside.to < segment.text.length) nodes.push(document.createTextNode(segment.text.slice(inside.to)));
    }
    at += segment.text.length;
  }
  if (nodes.length === 0 || nodes[nodes.length - 1]?.nodeType !== Node.TEXT_NODE) nodes.push(document.createTextNode(""));
  root.replaceChildren(...nodes);
}

const BLOCKS = new Set(["DIV", "P", "LI"]);

/** How much of the draft one node accounts for. A chip is its reference text;
 *  a line break is one newline; anything else is the sum of its children. */
function lengthOf(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue ?? "").length;
  if (!(node instanceof HTMLElement)) return 0;
  if (node.dataset.chipText !== undefined) return node.dataset.chipText.length;
  if (node.tagName === "BR") return 1;
  return [...node.childNodes].reduce((sum, child) => sum + lengthOf(child), 0);
}

function textOf(node: Node, index: number, siblings: number): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
  if (!(node instanceof HTMLElement)) return "";
  const chip = node.dataset.chipText;
  if (chip !== undefined) return chip;
  /**
   * A TRAILING `<br>` IS THE BROWSER'S, NOT THE USER'S. Chromium keeps one at
   * the end of an editable block so the last line has height; counting it would
   * append a newline to every message that ends in a line break, and then
   * another on the next keystroke.
   */
  if (node.tagName === "BR") return index === siblings - 1 ? "" : "\n";
  const children = [...node.childNodes];
  const inner = children.map((child, at) => textOf(child, at, children.length)).join("");
  // Defensive: we intercept every path that would create a block, but a browser
  // that made one anyway should read as a new line rather than as a joined word.
  return BLOCKS.has(node.tagName) && index > 0 ? `\n${inner}` : inner;
}

/** The draft, exactly as it will be sent. */
export function serialize(root: HTMLElement): string {
  const children = [...root.childNodes];
  return children.map((child, at) => textOf(child, at, children.length)).join("");
}

/** Where a DOM position falls in the draft string. */
function offsetOf(root: HTMLElement, target: Node, targetOffset: number): number {
  let total = 0;
  let found = false;
  const walk = (node: Node): void => {
    if (found) return;
    if (node === target) {
      if (node.nodeType === Node.TEXT_NODE) total += Math.min(targetOffset, (node.nodeValue ?? "").length);
      else total += [...node.childNodes].slice(0, targetOffset).reduce((sum, child) => sum + lengthOf(child), 0);
      found = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE || (node instanceof HTMLElement && (node.dataset.chipText !== undefined || node.tagName === "BR"))) {
      total += lengthOf(node);
      return;
    }
    for (const child of node.childNodes) {
      walk(child);
      if (found) return;
    }
  };
  walk(root);
  return total;
}

/** The selection as draft offsets, or nothing when it is not in this box. */
function selectionRange(root: HTMLElement): { start: number; end: number } | undefined {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return undefined;
  return { start: offsetOf(root, range.startContainer, range.startOffset), end: offsetOf(root, range.endContainer, range.endOffset) };
}

/**
 * Put the caret at a draft offset.
 *
 * AN OFFSET INSIDE A CHIP RESOLVES TO ITS LEADING EDGE. There is no caret
 * position inside a chip — that is what makes it one object — so the arithmetic
 * has to choose a side, and the front is the side that makes a subsequent
 * keystroke land where the eye expects.
 */
function placeCaret(root: HTMLElement, offset: number): void {
  const range = document.createRange();
  let remaining = Math.max(0, offset);
  let placed = false;

  const walk = (node: Node): void => {
    if (placed) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const length = (node.nodeValue ?? "").length;
      if (remaining <= length) {
        range.setStart(node, remaining);
        placed = true;
        return;
      }
      remaining -= length;
      return;
    }
    if (node instanceof HTMLElement && node.dataset.chipText !== undefined) {
      const length = node.dataset.chipText.length;
      if (remaining < length && node.parentNode) {
        range.setStart(node.parentNode, [...node.parentNode.childNodes].indexOf(node));
        placed = true;
        return;
      }
      remaining -= length;
      return;
    }
    if (node instanceof HTMLElement && node.tagName === "BR") {
      if (remaining < 1 && node.parentNode) {
        range.setStart(node.parentNode, [...node.parentNode.childNodes].indexOf(node));
        placed = true;
        return;
      }
      remaining -= 1;
      return;
    }
    for (const child of node.childNodes) {
      walk(child);
      if (placed) return;
    }
  };

  for (const child of root.childNodes) {
    walk(child);
    if (placed) break;
  }
  if (!placed) {
    range.selectNodeContents(root);
    range.collapse(false);
  }
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/**
 * WHERE THE CARET IS ON THE SCREEN (#561), in viewport coordinates.
 *
 * `Range.getBoundingClientRect()` ON A COLLAPSED RANGE IS EMPTY IN SOME
 * PLACES, and they are the ordinary ones: the caret sitting in the empty text
 * node `paint` leaves at the end, or in a box nobody has typed in yet. A rect
 * of zeros would put the pill in the corner of the window, so the fallbacks
 * are tried in the order that keeps it nearest the truth:
 *
 *   1. the collapsed range itself, which is right whenever there is text;
 *   2. the character BEFORE it, whose right edge is where the caret stands —
 *      this is the empty-trailing-node case, and it is the common one;
 *   3. the box's own first line, for a box with nothing in it at all.
 *
 * VIEWPORT COORDINATES, NOT THE BOX'S, because the pill is drawn in a portal on
 * `body` — see `dictation-caret-pill.tsx`. Anchoring it inside the composer
 * would put it under the composer's own `overflow-y-auto`, which is the one
 * place a floating badge must not be clipped.
 */
function caretRectIn(root: HTMLElement): DOMRect | undefined {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return undefined;

  const own = range.getBoundingClientRect();
  if (own.height > 0) return own;

  if (range.startContainer.nodeType === Node.TEXT_NODE && range.startOffset > 0) {
    const back = document.createRange();
    back.setStart(range.startContainer, range.startOffset - 1);
    back.setEnd(range.startContainer, range.startOffset);
    const previous = back.getBoundingClientRect();
    // Its RIGHT edge, collapsed: that is the side the caret is on.
    if (previous.height > 0) return new DOMRect(previous.right, previous.top, 0, previous.height);
  }

  const box = root.getBoundingClientRect();
  if (box.height <= 0) return undefined;
  const line = Number.parseFloat(window.getComputedStyle(root).lineHeight);
  return new DOMRect(box.left, box.top, 0, Number.isFinite(line) && line > 0 ? line : box.height);
}

export type ComposerEditorHandle = {
  focus: () => void;
  /** Is the caret in this box right now? */
  focused: () => boolean;
  /** Where the caret is on the screen, for something drawn beside it — see
   *  `caretRectIn`. `undefined` when the caret is not in this box. */
  caretRect: () => DOMRect | undefined;
  /**
   * WHAT A RUNNING DICTATION LOOKS LIKE IN THIS BOX (#561).
   *
   * Two marks, set together because they change together: `listening` tints the
   * caret while the microphone is open, and `interim` is the run of the draft
   * still being revised, drawn dimmer so settled words are tellable from words
   * that are still moving.
   *
   * REPAINTS ONLY WHEN THE RUN ACTUALLY MOVED. Interim frames arrive several
   * times a second and most of them follow a `replaceRange` that has already
   * painted; repainting again for an unchanged span would be a second
   * `replaceChildren` and a second caret placement per frame, which is visible
   * as a flicker on a slow machine.
   */
  dictating: (state: { listening: boolean; interim?: { start: number; end: number } }) => void;
  /** The caret's index in the draft, or the draft's length when unfocused. */
  caret: () => number;
  /**
   * Swap a run of the draft — how a completion replaces its own trigger, and
   * how a live dictation revises the words it has not finalised yet.
   *
   * RETURNS THE COMMITTED DRAFT, for `insertAtCaret`'s reason: a caller
   * outside React cannot wait for the render to learn what the box now holds,
   * and the dictation writer needs it to know where its own span ended up.
   * The completion menu ignores it, which is what a return value is for.
   */
  replaceRange: (start: number, end: number, text: string) => string;
  /**
   * Splice text in at the caret, spaced the way a person would type it, and
   * return the draft that was committed.
   *
   * THE RETURN IS FOR A CALLER WHO CANNOT WAIT FOR THE RENDER. `onChange` is
   * the parent's route to the new string and stays the route for anything on
   * screen; the page API (`lib/page-api.ts`) answers an external client
   * synchronously, and the React state it would have to read back has not
   * arrived yet at the moment it must answer.
   */
  insertAtCaret: (text: string) => string;
};

export const ComposerEditor = forwardRef<
  ComposerEditorHandle,
  {
    value: string;
    onChange: (value: string) => void;
    /** Fires BEFORE this component's own handling, and a handler that calls
     *  `preventDefault` keeps the key. That is how the parent claims Enter. */
    onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
    /** The caret moved without the text changing — arrow keys, a click. The
     *  completion menu needs it, because moving out of a `@word` closes it. */
    onSelectionChange?: () => void;
    /** Pasted files become attachments, exactly as they did in the textarea. */
    onPasteFiles?: (files: File[]) => void;
    /** The caret entered this box. The composer registry's "most recently
     *  focused" is this event and nothing else — see lib/composer-registry.ts. */
    onFocus?: () => void;
    placeholder?: string;
    disabled?: boolean;
    id?: string;
    /** WHICH COMPOSER THIS IS, ON THE EDITABLE ROOT ITSELF. Documented as
     *  stable for external clients in `docs/page-api.md`, beside `data-slot`. */
    "data-composer"?: "session";
    className?: string;
  }
>(function ComposerEditor(
  { value, onChange, onKeyDown, onSelectionChange, onPasteFiles, onFocus, placeholder, disabled, id, "data-composer": dataComposer, className },
  ref,
) {
  const root = useRef<HTMLDivElement>(null);
  /** The text the DOM currently shows. The guard that stops our own echo from
   *  repainting the box mid-keystroke. */
  const painted = useRef("");
  const mounted = useRef(false);
  const [empty, setEmpty] = useState(true);
  /**
   * THE RUN STILL BEING REVISED (#561). A ref rather than state for the reason
   * everything else in this file is imperative: it is a property of the DRAWING,
   * every paint already reads it, and a state update per interim frame would
   * re-render the composer several times a second.
   */
  const interim = useRef<{ start: number; end: number }>(null);
  /** Whether the microphone is open, which is what tints the caret. State, not
   *  a ref: it changes twice per dictation and it is a class on the element
   *  React does own. */
  const [listening, setListening] = useState(false);

  const commit = useCallback(
    (text: string) => {
      painted.current = text;
      setEmpty(text.length === 0);
      onChange(text);
    },
    [onChange],
  );

  /** Repaint, report, and put the caret where the gesture left it. */
  const rewrite = useCallback(
    (text: string, caret: number) => {
      const box = root.current;
      if (!box) return;
      paint(box, text, interim.current ?? undefined);
      commit(text);
      box.focus();
      placeCaret(box, caret);
    },
    [commit],
  );

  useEffect(() => {
    const box = root.current;
    if (!box) return;
    if (!mounted.current) {
      mounted.current = true;
      paint(box, value, interim.current ?? undefined);
      painted.current = value;
      setEmpty(value.length === 0);
      return;
    }
    if (value === painted.current) return;
    // The parent replaced the whole draft — cleared after a send, or recalled a
    // queued line. A replacement puts the caret at the end; an edit would have
    // come through `onInput` and never reached here.
    //
    // AND IT DROPS THE INTERIM RUN. Offsets into a draft that has been replaced
    // wholesale describe nothing, and a dimmed span left over one would grey
    // out whatever text now happens to sit at those numbers — the dictation
    // writer drops its own span on the same evidence (see `interim.ts`).
    interim.current = null;
    paint(box, value);
    painted.current = value;
    setEmpty(value.length === 0);
    if (document.activeElement === box) placeCaret(box, value.length);
  }, [value]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => root.current?.focus(),
      focused: () => Boolean(root.current) && document.activeElement === root.current,
      caretRect: () => {
        const box = root.current;
        return box ? caretRectIn(box) : undefined;
      },
      dictating: ({ listening: on, interim: run }) => {
        setListening(on);
        const was = interim.current;
        const same = was === null ? run === undefined : run !== undefined && was.start === run.start && was.end === run.end;
        interim.current = run ?? null;
        // SAME RUN, NOTHING TO REDRAW — see the handle's own note. The common
        // frame is one where `replaceRange` has just painted this very span.
        if (same) return;
        const box = root.current;
        if (!box) return;
        // The caret stays where the dictation left it: at the end of the words
        // just heard, which is where the next ones go.
        const at = selectionRange(box)?.end ?? painted.current.length;
        paint(box, painted.current, interim.current ?? undefined);
        if (document.activeElement === box) placeCaret(box, at);
      },
      caret: () => {
        const box = root.current;
        if (!box) return painted.current.length;
        const range = selectionRange(box);
        return range ? range.end : painted.current.length;
      },
      replaceRange: (start, end, text) => {
        const next = replaceTextRange(painted.current, start, end, text);
        rewrite(next.text, next.cursor);
        return next.text;
      },
      insertAtCaret: (text) => {
        const box = root.current;
        const range = box ? selectionRange(box) : undefined;
        const at = range ? range.end : painted.current.length;
        const next = insertReference(painted.current, text, at);
        rewrite(next.draft, next.caret);
        return next.draft;
      },
    }),
    [rewrite],
  );

  return (
    <div className={cn("relative w-full", className)}>
      <div
        ref={root}
        id={id}
        role="textbox"
        aria-multiline="true"
        contentEditable={!disabled}
        suppressContentEditableWarning
        spellCheck
        data-slot="composer-editor"
        data-composer={dataComposer}
        // WHILE THE MICROPHONE IS OPEN, SO A READER CAN SEE IT IS (#561). The
        // pill at the caret is the loud signal; this is the quiet one, and it
        // is the one that survives the pill being off-screen because the box
        // has scrolled.
        data-dictating={listening ? "" : undefined}
        // 76px and 15px/24 are the textarea's, kept: a composer is the largest
        // single target on the screen and the type has to hold its own against
        // the transcript it sits under.
        className={cn(
          "max-h-48 min-h-[76px] w-full overflow-y-auto whitespace-pre-wrap break-words px-3 pt-3 pb-2 text-[0.9375rem] leading-6 outline-none",
          "data-dictating:caret-primary",
          disabled && "opacity-60",
        )}
        onInput={() => {
          const box = root.current;
          if (box) commit(serialize(box));
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented) return;
          if (event.key === "Enter") {
            /**
             * Only a SHIFTED Enter reaches here — the parent claims the plain
             * one to send. `insertLineBreak` rather than a repaint, because a
             * repaint would empty the browser's undo stack every time somebody
             * started a new line.
             */
            event.preventDefault();
            document.execCommand("insertLineBreak");
            const box = root.current;
            if (box) commit(serialize(box));
          }
        }}
        onFocus={() => onFocus?.()}
        onKeyUp={() => onSelectionChange?.()}
        onMouseUp={() => onSelectionChange?.()}
        onBlur={() => onSelectionChange?.()}
        onPaste={(event) => {
          /**
           * PASTE A SCREENSHOT AND IT ATTACHES — the textarea's behaviour, kept
           * verbatim. ⌘⇧4 then ⌘V is how anyone actually shows an agent what
           * they are looking at.
           */
          const files = [...event.clipboardData.files];
          if (files.length > 0 && onPasteFiles) {
            event.preventDefault();
            onPasteFiles(files);
            return;
          }
          /**
           * TEXT IS PASTED BY US, NOT BY THE BROWSER, and the repaint is the
           * point: a path pasted from a terminal draws as a chip on arrival
           * instead of waiting for something else to trigger a redraw. It also
           * strips whatever HTML the clipboard was carrying, which is the
           * behaviour a message box should have had all along.
           */
          const text = event.clipboardData.getData("text/plain");
          if (!text) return;
          event.preventDefault();
          const box = root.current;
          const range = box ? selectionRange(box) : undefined;
          const start = range?.start ?? painted.current.length;
          const end = range?.end ?? painted.current.length;
          const next = replaceTextRange(painted.current, Math.min(start, end), Math.max(start, end), text);
          rewrite(next.text, next.cursor);
        }}
      />
      {empty && placeholder ? (
        <span aria-hidden className="pointer-events-none absolute left-3 top-3 select-none text-[0.9375rem] leading-6 text-muted-foreground">
          {placeholder}
        </span>
      ) : null}
    </div>
  );
});

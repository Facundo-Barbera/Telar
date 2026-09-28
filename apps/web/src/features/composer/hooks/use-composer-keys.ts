"use client";

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { Completion } from "../completions";
import { isStashable, type ComposerStash } from "./use-composer-stash";
import type { ComposerCompletions } from "./use-composer-completions";

const ESC_ARM_WINDOW_MS = 3_000;

/** Escape twice stops a running turn; the first press arms, and any other key disarms. */
export function useEscArm(busy: boolean, onStop: () => void) {
  const [raw, setArmed] = useState(false);
  const armedAt = useRef(0);
  const armed = raw && busy;
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), ESC_ARM_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);
  const press = () => {
    if (armed && Date.now() - armedAt.current <= ESC_ARM_WINDOW_MS) {
      setArmed(false);
      onStop();
    } else {
      armedAt.current = Date.now();
      setArmed(true);
    }
  };
  const disarm = () => {
    if (armed) setArmed(false);
  };
  return { armed, press, disarm };
}

function stashKeys(event: KeyboardEvent<HTMLDivElement>, stash: ComposerStash): boolean {
  if (event.key === "Escape") {
    event.preventDefault();
    stash.setOpen(false);
    return true;
  }
  const { rows } = stash.shelf;
  if (rows.length === 0) return false;
  const picked = () => rows[Math.min(stash.active, rows.length - 1)];
  const cmd = event.metaKey || event.ctrlKey;
  if (event.key === "ArrowDown") stash.setActive((index) => (index + 1) % rows.length);
  else if (event.key === "ArrowUp") stash.setActive((index) => (index - 1 + rows.length) % rows.length);
  else if (event.key === "Enter") {
    const row = picked();
    if (row) stash.restore(row);
  } else if (event.key === "Backspace" && cmd) {
    // ⌘⌫, not a bare Backspace: one twitch must not delete a saved prompt.
    const row = picked();
    if (row) stash.shelf.drop(row);
    stash.setActive((index) => Math.max(0, Math.min(index, rows.length - 2)));
  } else return false;
  event.preventDefault();
  return true;
}

function menuKeys(event: KeyboardEvent<HTMLDivElement>, menu: ComposerCompletions, pick: (completion: Completion) => void): boolean {
  const { completions } = menu;
  if (event.key === "ArrowDown") menu.setActive((index) => (index + 1) % completions.length);
  else if (event.key === "ArrowUp") menu.setActive((index) => (index - 1 + completions.length) % completions.length);
  else if (event.key === "Enter" || event.key === "Tab") {
    const picked = completions[Math.min(menu.active, completions.length - 1)];
    if (picked) pick(picked);
  } else if (event.key === "Escape") menu.setDismissed(true);
  else return false;
  event.preventDefault();
  return true;
}

/** The editor's keys, in order: ⌘S, an open stash list, an open completion list, then send, stop and disarm. */
export function composerKeyHandler({
  draft,
  attachments,
  busy,
  questionActive,
  stash,
  menu,
  pick,
  submit,
  esc,
}: {
  draft: string;
  attachments: readonly File[];
  busy: boolean;
  questionActive: boolean;
  stash: ComposerStash;
  menu: ComposerCompletions;
  pick: (completion: Completion) => void;
  submit: () => void;
  esc: ReturnType<typeof useEscArm>;
}) {
  return (event: KeyboardEvent<HTMLDivElement>) => {
    // IME composition: Enter is committing a candidate, not sending.
    if (event.nativeEvent.isComposing) return;
    // Always prevented, so the browser's Save dialog never opens.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (stash.stashing) return;
      if (isStashable(draft, attachments)) void stash.stash();
      else stash.toggle();
      return;
    }
    if (stash.open && stashKeys(event, stash)) return;
    if (menu.open && menu.completions.length > 0 && menuKeys(event, menu, pick)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }
    // While a question is open the draft is parked, so stop and disarm do not apply.
    if (questionActive) return;
    if (event.key === "Escape" && busy) {
      event.preventDefault();
      esc.press();
      return;
    }
    esc.disarm();
  };
}

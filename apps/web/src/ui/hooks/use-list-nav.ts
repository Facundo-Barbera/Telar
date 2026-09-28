"use client";

import { useState, type KeyboardEvent } from "react";

export type ListNav = {
  /** The highlighted row, clamped to the list; -1 when it is empty. */
  active: number;
  setActive: (index: number) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  /** The id of the highlighted option, for `aria-activedescendant`. */
  activeId: string | undefined;
  optionProps: (index: number) => { id: string; role: "option"; "aria-selected": boolean };
};

/**
 * Arrow keys move a highlight over `count` rows and Enter picks it. Put `onKeyDown` on the
 * field that keeps focus; the highlight stays valid when the list shrinks under it.
 */
export function useListNav({ count, onPick, wrap = true, idPrefix }: { count: number; onPick: (index: number) => void; wrap?: boolean; idPrefix: string }): ListNav {
  const [index, setActive] = useState(0);
  const active = count === 0 ? -1 : Math.min(index, count - 1);

  const onKeyDown = (event: KeyboardEvent) => {
    // An IME's own Enter commits a candidate; it is not a selection.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (count === 0) return;
      event.preventDefault();
      const next = Math.max(active, 0) + (event.key === "ArrowDown" ? 1 : -1);
      setActive(wrap ? (next + count) % count : Math.min(Math.max(next, 0), count - 1));
      return;
    }
    if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      onPick(active);
    }
  };

  const idOf = (row: number) => `${idPrefix}-${row}`;
  return {
    active,
    setActive,
    onKeyDown,
    activeId: active >= 0 ? idOf(active) : undefined,
    optionProps: (row) => ({ id: idOf(row), role: "option", "aria-selected": row === active }),
  };
}

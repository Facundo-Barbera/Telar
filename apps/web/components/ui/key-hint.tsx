"use client";

/**
 * THE CHORD A CONTROL ANSWERS TO, SHOWN ON THE CONTROL — issue #401.
 *
 * Hold ⌘ (Ctrl elsewhere) and every surface bound to a chord says so where it
 * is: the rail's first nine rows wear ⌘1…⌘9, the Open menu's reveal row wears
 * ⌘O, the panel's tab strip wears its arrows. Release and they are gone. Anyone
 * who uses macOS knows the gesture from Slack and Arc, and it is the only way to
 * teach a keyboard app's shortcuts that does not cost a permanent row of chrome
 * per shortcut or a page nobody opens.
 *
 * IT READS THE LIVE KEYMAP, never a literal. A person who rebound ⌘K to ⌘/ in
 * Settings › Keybindings must see ⌘/ here, and a command they UNBOUND must show
 * nothing at all rather than a key that does nothing — which is why this takes a
 * `CommandId` and not a string of caps. `useKeymap` is the same store the
 * dispatcher matches against, so the hint and the key cannot disagree.
 *
 * `aria-hidden`, on both parts. A screen reader gets the chord from the
 * control's own accessible name and the application menu; a cluster of caps
 * appearing and vanishing under the reader's cursor as a modifier is held would
 * be noise it cannot act on.
 */

import type { ReactNode } from "react";
import type { CommandId } from "@/lib/commands";
import { keyCaps, useKeyCapPlatform } from "@/lib/key-caps";
import { useModifierHeld } from "@/lib/modifier-held";
import { useKeymap } from "@/lib/use-command-keys";
import { cn } from "@/lib/utils";

/** ~80ms: long enough not to pop, short enough that the caps are there by the
 *  time the eye arrives. No exit animation — a release should feel like letting
 *  go, not like a control fading out under you. */
const APPEAR = "animate-in fade-in-0 duration-[80ms] motion-reduce:animate-none";

export function KeyHint({
  command,
  /** Draw the caps whether or not the modifier is held. For the one control that
   *  ALREADY showed its chord permanently — the rail's search field, whose ⌘K
   *  was a hardcoded `<kbd>` — so this pass makes that hint live without taking
   *  away an affordance nobody asked to lose. */
  always = false,
  className,
}: {
  command: CommandId;
  always?: boolean;
  className?: string;
}) {
  const keymap = useKeymap();
  const platform = useKeyCapPlatform();
  const held = useModifierHeld();
  const caps = keyCaps(keymap[command] ?? "", platform);
  // Unbound in the current keymap: nothing to promise, so nothing is drawn.
  if (caps.length === 0) return null;
  if (!always && !held) return null;
  return (
    <span
      aria-hidden
      data-slot="key-hint"
      className={cn("pointer-events-none inline-flex shrink-0 items-center gap-0.5", !always && APPEAR, className)}
    >
      {caps.map((cap, index) => (
        <kbd
          key={`${cap}-${index}`}
          className="rounded-[3px] bg-foreground/8 px-1 font-mono text-[0.625rem] leading-4 text-muted-foreground"
        >
          {cap}
        </kbd>
      ))}
    </span>
  );
}

/**
 * THE HINT OVER THE TRAILING EDGE, so NOTHING MOVES when it appears.
 *
 * A rail row's right-hand end already carries a timestamp or an activity badge,
 * and a tab already carries a count. Inserting caps beside them would reflow
 * every row in the list on a keypress — the one thing a hold-to-peek gesture
 * must not do, because the thing you are peeking at is where a row sits. So the
 * caps are absolutely positioned over that corner and what is under them dims,
 * which is also how a reader knows the two are the same slot rather than two
 * facts competing.
 *
 * A command nobody is bound to dims nothing: `KeyHint` draws no caps for it, and
 * a row that faded its own timestamp to reveal an empty box would be worse than
 * a row that did nothing.
 */
export function KeyHintOverlay({
  command,
  children,
  className,
}: {
  command: CommandId;
  children: ReactNode;
  className?: string;
}) {
  const keymap = useKeymap();
  const held = useModifierHeld();
  const showing = held && Boolean(keymap[command]);
  return (
    <span className={cn("relative inline-flex shrink-0 items-center", className)}>
      <span className={cn("transition-opacity duration-[80ms] motion-reduce:transition-none", showing && "opacity-20")}>{children}</span>
      {showing && (
        <span aria-hidden className="absolute inset-y-0 right-0 flex items-center">
          <KeyHint command={command} />
        </span>
      )}
    </span>
  );
}

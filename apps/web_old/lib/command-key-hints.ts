// Hold-to-reveal hints for the command keys (issue #46's discoverability
// follow-up): press and HOLD ⌘ (or Ctrl off-Mac) with nothing else, and the
// sidebar elements a binding targets grow a small badge saying which chord
// reaches them — ⌘1..9 over the recent conversations, ⌘N on New Session,
// ⌘, on Settings. Release, chord, or leave the window and they vanish.
//
// This module is the PURE half — the state machine and the formatting — so
// the behavior is testable in a repo with no DOM harness (the same split
// command-keys.ts itself uses). The DOM wiring lives in
// use-command-key-hints.ts and stays thin enough to pin structurally.

import {
  recentSessionsForCommandKeys,
  type SidebarSession,
} from "@/lib/session-list";

/** How long the modifier must be held ALONE before hints appear. Shorter and
 *  every ⌘C / ⌘V / ⌘K flashes the whole sidebar on the way to its chord;
 *  longer and the gesture reads as broken. 500ms is the familiar tier —
 *  about what macOS uses before showing pressed-key alternatives. */
export const HINT_HOLD_MS = 500;

export type HintState = "idle" | "arming" | "showing";

export type HintSignal =
  /** keydown of Meta/Control */
  | "modifier-down"
  /** the arming timer fired: the modifier was held alone the whole time */
  | "hold-elapsed"
  /** keydown of anything else — the user is CHORDING, not asking */
  | "other-key"
  /** keyup of Meta/Control */
  | "modifier-up"
  /** window blur or the tab going hidden — ⌘Tab must not strand "showing",
   *  since the matching keyup fires in whatever app got focus instead */
  | "window-away";

/**
 * The whole gesture as one transition table. Deliberately total — every
 * (state, signal) pair resolves — so the DOM hook holds NO logic beyond
 * "translate events to signals and run one timer while arming".
 *
 * The one asymmetry worth naming: `other-key` cancels from BOTH arming and
 * showing. A chord mid-hold means the user found what they were looking for;
 * leaving the hints up while the app navigates under them would pin stale
 * badges to elements that may be gone.
 */
export function nextHintState(state: HintState, signal: HintSignal): HintState {
  switch (signal) {
    case "modifier-down":
      // Repeat keydowns of a held modifier arrive on some platforms; they
      // must not restart the hold (arming stays arming, showing stays showing).
      return state === "idle" ? "arming" : state;
    case "hold-elapsed":
      // A timer that outlives its arming (cleared late, or fired after a
      // cancel raced it) must not resurrect hints from idle or re-enter
      // showing — only the arming it belongs to may promote.
      return state === "arming" ? "showing" : state;
    case "other-key":
    case "modifier-up":
    case "window-away":
      return "idle";
  }
}

/** The keys whose HOLD means "show me" — exactly the CommandOrControl pair
 *  the binding table is built on (apps/desktop/command-keys.js). */
export function isHintModifierKey(key: string): boolean {
  return key === "Meta" || key === "Control";
}

/** Platform string → which modifier glyph the hints wear. Pure so it is
 *  testable; the hook feeds it `navigator.platform || navigator.userAgent`. */
export function isMacPlatformString(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/.test(platform);
}

/** "n" → "⌘N" on a Mac-like platform, "Ctrl+N" elsewhere — the same
 *  CommandOrControl semantics the accelerators declare, rendered the way
 *  each platform's users read shortcuts. */
export function formatCommandKeyHint(key: string, mac: boolean): string {
  const cap = key.length === 1 ? key.toUpperCase() : key;
  return mac ? `⌘${cap}` : `Ctrl+${cap}`;
}

/**
 * Which jump number (1-9) each session id wears, keyed BY ID rather than by
 * row position, deliberately: ⌘1..9 index into the GLOBAL unfiltered recent
 * band (recentSessionsForCommandKeys), while the sidebar may be rendering a
 * project-scoped, filtered, or searched list in a different order. An
 * id-keyed map stays honest in every view — a row shows its true global
 * number or nothing, and a scoped list showing a sparse "⌘4 ⌘7" is telling
 * the truth about what those keys do.
 */
export function commandKeyJumpNumbers(
  sessions: readonly SidebarSession[],
  activeSessionId: string | undefined,
  now: number,
): Map<string, number> {
  const numbers = new Map<string, number>();
  recentSessionsForCommandKeys(sessions, activeSessionId, now).forEach(
    (session, index) => numbers.set(session.id, index + 1),
  );
  return numbers;
}

/**
 * THE KEYS A FOCUSED TERMINAL TAKES BACK FROM THE COCKPIT (#198).
 *
 * Telar is a terminal emulator, not a shell configurator: what a key MEANS is
 * the user's dotfiles' business. Our only job is to make sure the byte arrives.
 * Three of them do not arrive on their own.
 *
 * `Escape` — the owner's `~/.zshrc` runs `bindkey -v`, so Escape is how you
 * leave insert mode. A vi-mode shell with no Escape is not a shell.
 * `^W` (0x17) — zsh's `backward-kill-word`.
 * `^R` (0x12) — zsh's `history-incremental-search-backward`.
 *
 * WHAT ACTUALLY EATS THEM, measured rather than assumed, because the obvious
 * answer is wrong on this platform:
 *
 *   - NOT Electron's own accelerators. `main.js`'s menu carries `role: "reload"`
 *     and `role: "windowMenu"`, and on macOS those are ⌘R and ⌘W — *Command*, not
 *     Control. A bare `^R` reaches the page here. (On Windows they would be the
 *     same chord, and this module would be doing much more work; Windows
 *     packaging does not exist — see docs/terminal-host.md §4.)
 *   - THE COCKPIT'S OWN WINDOW LISTENER, which is the real one.
 *     `useCommandKeys` listens on `window` and `resolveWebCommandKeyAction`
 *     treats any ctrl/meta press as "chorded", so its focus rule — the one that
 *     protects a text field from a bare key — deliberately does NOT protect a
 *     field from `^R`. Nothing is bound to `^R` in the shipped keymap, but the
 *     settings pane lets a person bind anything to anything, and the day they
 *     bind one of these the terminal would silently stop being a terminal.
 *
 * SO TWO MECHANISMS, and they cover different halves:
 *
 *   1. `stopPropagation` on the keydown, from inside xterm's own handler. The
 *      window listener sits at the end of the bubble chain, so this is what
 *      stops it — `preventDefault` alone would not, because that listener does
 *      not check `defaultPrevented`.
 *   2. `TERMINAL_CHORD_CLAIMS` through `claimChords`, which is what reaches the
 *      MAIN process: a command carrying a `menu` becomes a macOS key equivalent,
 *      and macOS matches those before the page ever sees the keydown. No bubble
 *      to stop there, so no `stopPropagation` can help.
 *
 * ONE COST, STATED: this repo's chord vocabulary folds Control and Command into
 * one `CommandOrControl` token (`apps/desktop/command-keys.js`), so claiming
 * `^W` also stands ⌘W down while the terminal has focus. Nothing is bound to
 * either by default. It is the right trade anyway — a focused terminal is the
 * one surface where those presses are the shell's — but it is a trade, not a
 * free win.
 */

/** A keydown, as much of one as this needs — so the rule runs against a real
 *  `KeyboardEvent` and against a plain object in a test. */
export type TerminalKeyEvent = {
  key?: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

/**
 * The control byte for a `^<letter>` press: `^A` is 1, `^W` is 23 (0x17), `^R`
 * is 18 (0x12). Only the two the shell needs are listed — this is not a general
 * control-code table, and adding one would mean taking that chord away from the
 * cockpit for a reason nobody had measured.
 */
const CONTROL_BYTES: Readonly<Record<string, string>> = {
  w: "\u0017",
  r: "\u0012",
};

/** `KeyboardEvent.code` is layout-independent; `key` is what a synthesised
 *  event usually carries. Either answers "which letter". */
function letterOf(event: TerminalKeyEvent): string | undefined {
  const fromKey = typeof event.key === "string" && event.key.length === 1 ? event.key.toLowerCase() : undefined;
  if (fromKey !== undefined) return fromKey;
  const code = typeof event.code === "string" ? /^Key([A-Z])$/.exec(event.code) : null;
  return code ? code[1]!.toLowerCase() : undefined;
}

/**
 * The bytes this press must reach the PTY as, or nothing when xterm's own
 * handling is already right.
 *
 * RETURNING BYTES RATHER THAN A BOOLEAN is what makes this checkable. A
 * predicate ("should the terminal keep this key?") is satisfied by a handler
 * that fires and swallows the press, which is exactly the bug; the caller
 * writes what this returns, so a test can assert `\u0017` arrived at the host.
 */
export function ptyBytesForKey(event: TerminalKeyEvent): string | undefined {
  // A chord with Command or Option in it is the cockpit's or the system's. Only
  // the plain presses below belong to the shell.
  if (event.metaKey === true || event.altKey === true) return undefined;
  if (event.ctrlKey === true) {
    const letter = letterOf(event);
    return letter === undefined ? undefined : CONTROL_BYTES[letter];
  }
  if (event.shiftKey === true) return undefined;
  return event.key === "Escape" ? "\u001b" : undefined;
}

/**
 * The chords a mounted terminal claims, in `command-keys.js`'s canonical
 * spelling. Claimed while the surface is MOUNTED rather than while it is
 * focused: a claim released on blur and retaken on focus would race the
 * application menu's rebuild, and a menu that is a frame behind is a key
 * equivalent firing over a live shell.
 */
export const TERMINAL_CHORD_CLAIMS: readonly string[] = ["Escape", "CommandOrControl+W", "CommandOrControl+R"];

"use client";

/**
 * EVERY KEY THIS APP ANSWERS TO, WRITTEN DOWN.
 *
 * The table has been alive since issue #16 — `apps/desktop/command-keys.js` is
 * what builds the Electron menu's accelerators AND what the renderer matches a
 * keydown against — and there has never been a screen that says what is in it.
 * A person who wanted to know whether ⌘2 did anything had to press it.
 *
 * READ-ONLY, AND NOTHING SAYS SO IN WORDS. Rebinding means the Electron menu
 * rebuilding itself from stored bindings, which is a shell change and a store.
 * The caption that used to explain that ("rebinding needs the app menu to
 * rebuild itself from stored keys, which is not built yet") was an
 * implementation note in user copy (#357): a reader learns the table is fixed
 * from the fact that nothing on it is pressable, which is the same lesson
 * without the apology.
 *
 * THE NINE JUMPS ARE ONE ROW. ⌘1 through ⌘9 are one idea generated nine times
 * in the table, and nine rows of it was three quarters of this pane saying the
 * same thing — see `keybindingRows`.
 *
 * THE TABLE IS THE SOURCE, NOT A COPY OF IT. Every row below is derived from
 * `COMMAND_KEY_BINDINGS`, so a binding added to that file appears here without
 * anybody remembering to — which is the failure mode a hand-written shortcut
 * list has, and the reason Telar has never had one.
 *
 * THE NAMESPACES ARE THIS COCKPIT'S, NOT THE MENU'S. The table's `label` is the
 * Electron menu item's text, so it is grouped the way a File menu is grouped
 * ("New Session", "Jump to Conversation"). In a browser tab there is no File
 * menu, so a row reading `File: New Session` would name a place the reader
 * cannot see. `NAMES` restates each id in the vocabulary of the app around it,
 * and the test beside this file fails if a binding is added without one.
 */

import { useEffect, useState } from "react";
import { KeyboardIcon } from "lucide-react";
import { COMMAND_KEY_BINDINGS, type CommandKeyBinding } from "@/lib/command-keys";
import { Row, SettingsGroup } from "./settings-shell";

/**
 * Which key names a reader is looking at. The accelerators are
 * `CommandOrControl+…` by design (issue #16), so the SAME table reads ⌘ on a
 * Mac and Ctrl on a Windows build — a cap that hardcoded one would be wrong on
 * the other rather than merely unstyled.
 */
export type KeyCapPlatform = "mac" | "other";

/** Modifier glyphs, in the register macOS itself uses on a menu. */
const MAC_GLYPHS: Record<string, string> = {
  commandorcontrol: "⌘",
  command: "⌘",
  cmd: "⌘",
  control: "⌃",
  ctrl: "⌃",
  shift: "⇧",
  alt: "⌥",
  option: "⌥",
};

/** The same modifiers spelled out, where there are no glyphs for them. */
const OTHER_NAMES: Record<string, string> = {
  commandorcontrol: "Ctrl",
  command: "Ctrl",
  cmd: "Ctrl",
  control: "Ctrl",
  ctrl: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  option: "Alt",
};

/**
 * An Electron accelerator as the caps a reader sees, one per key.
 *
 * A SPLIT RATHER THAN A STRING, because the row draws a box per key — "⌘ N" as
 * one cap reads as a key called "⌘ N". A single-character key is upper-cased
 * (`n` → `N`) and anything longer is left as the table wrote it, so a future
 * `Enter` or `Escape` needs no entry here to render.
 */
export function keyCaps(accelerator: string, platform: KeyCapPlatform): string[] {
  const named = platform === "mac" ? MAC_GLYPHS : OTHER_NAMES;
  return accelerator.split("+").map((part) => named[part.toLowerCase()] ?? (part.length === 1 ? part.toUpperCase() : part));
}

/** What each binding is called HERE — see the note at the top about why the
 *  menu's own labels do not travel into a browser tab. */
const NAMES: Record<string, { namespace: string; command: string }> = {
  "new-session": { namespace: "Conversation", command: "New" },
  "new-tab": { namespace: "Window", command: "New tab" },
  settings: { namespace: "Application", command: "Settings" },
};

export type KeybindingRow = {
  id: string;
  /** `Namespace: Command`, the reference's own row title. */
  title: string;
  caps: string[];
  /** The far end of a FOLDED RANGE. `⌘1–⌘9` is one row rather than nine, so
   *  the row needs a second chord to draw after the dash. */
  through?: string[];
};

/**
 * The table, as rows.
 *
 * `bindings` is a parameter so the derivation is testable against a table this
 * app does not ship — including one carrying an id `NAMES` has never heard of,
 * which must still produce a row rather than throwing.
 *
 * THE JUMPS FOLD, AND THE FOLD IS DERIVED TOO. The table generates one binding
 * per conversation slot; the pane's reader learns nothing from the seventh that
 * the first did not teach them, and nine near-identical rows buried the three
 * bindings that are actually distinct. The range is taken from the LOWEST and
 * HIGHEST jump the table carries rather than hardcoding 1 and 9, so a tenth slot
 * would widen the row instead of going unlisted. A table with exactly one jump
 * folds to nothing and keeps its ordinary row.
 */
export function keybindingRows(
  platform: KeyCapPlatform,
  bindings: readonly CommandKeyBinding[] = COMMAND_KEY_BINDINGS,
): KeybindingRow[] {
  const jumps = bindings.filter((binding) => binding.jump).sort((left, right) => (left.jump ?? 0) - (right.jump ?? 0));
  const folded = jumps.length > 1 ? jumps : [];
  const first = folded[0];
  const last = folded[folded.length - 1];

  const rows: KeybindingRow[] = [];
  for (const binding of bindings) {
    if (binding.jump && folded.length > 0) {
      // One row for the whole run, emitted where the first of them sat so the
      // list keeps the table's own order.
      if (binding !== first) continue;
      rows.push({
        id: "jump",
        title: `Rail: Jump to conversation ${first.jump}–${last!.jump}`,
        caps: keyCaps(first.accelerator, platform),
        through: keyCaps(last!.accelerator, platform),
      });
      continue;
    }
    const named = binding.jump
      ? { namespace: "Rail", command: `Jump to conversation ${binding.jump}` }
      : // An id with no entry falls back to the menu's own label: a row that
        // reads a little like a menu item beats a binding that is not listed.
        (NAMES[binding.id] ?? { namespace: "Application", command: binding.label });
    rows.push({ id: binding.id, title: `${named.namespace}: ${named.command}`, caps: keyCaps(binding.accelerator, platform) });
  }
  return rows;
}

/** One key, in a box. `kbd` because that is what it is. */
function Caps({ caps, through }: { caps: readonly string[]; through?: readonly string[] }) {
  const box = (cap: string, at: number) => (
    <kbd
      key={`${cap}-${at}`}
      className="inline-flex min-w-5 items-center justify-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem] leading-none text-muted-foreground"
    >
      {cap}
    </kbd>
  );
  return (
    <span className="flex items-center gap-1">
      {caps.map(box)}
      {through && (
        <>
          {/* An en dash rather than a third cap: the range is between the two
              chords, not a key you press. */}
          <span className="px-0.5 text-[0.6875rem] text-muted-foreground/70">–</span>
          {through.map(box)}
        </>
      )}
    </span>
  );
}

export function KeybindingsPage() {
  /**
   * WHICH KEYBOARD, READ AFTER THE FIRST PAINT. The platform is a client fact
   * and this pane renders on the server first, so seeding from `navigator`
   * would make the two disagree about the same markup — the reason every
   * loader in this directory defers a tick. macOS is the default because the
   * desktop shell is a Mac app; a browser on anything else corrects it before
   * the reader has finished reading the first row.
   */
  const [platform, setPlatform] = useState<KeyCapPlatform>("mac");
  useEffect(() => {
    const task = window.setTimeout(() => {
      const agent = `${navigator.userAgent} ${navigator.platform ?? ""}`;
      setPlatform(/mac|iphone|ipad|ipod/i.test(agent) ? "mac" : "other");
    }, 0);
    return () => window.clearTimeout(task);
  }, []);

  const rows = keybindingRows(platform);

  return (
    <SettingsGroup
      title="Keyboard shortcuts"
      // The plain count the reference puts on its section header. It counts
      // BINDINGS rather than rows, because the folded jump row stands for nine
      // of them — a "4 bindings" over a pane that answers to twelve chords
      // would be the fold telling a lie about the table.
      action={<span className="text-xs tabular-nums text-muted-foreground">{COMMAND_KEY_BINDINGS.length} bindings</span>}
    >
      {rows.map((row) => (
        <Row
          key={row.id}
          label={row.title}
          icon={KeyboardIcon}
          control={<Caps caps={row.caps} {...(row.through ? { through: row.through } : {})} />}
        />
      ))}
    </SettingsGroup>
  );
}

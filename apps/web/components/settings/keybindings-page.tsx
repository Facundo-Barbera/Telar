"use client";

/**
 * EVERY KEY THIS APP ANSWERS TO, WRITTEN DOWN.
 *
 * The table has been alive since issue #16 — `apps/desktop/command-keys.js` is
 * what builds the Electron menu's accelerators AND what the renderer matches a
 * keydown against — and there has never been a screen that says what is in it.
 * A person who wanted to know whether ⌘2 did anything had to press it.
 *
 * READ-ONLY, AND THAT IS THE WHOLE FEATURE FOR NOW. Rebinding means the
 * Electron menu rebuilding itself from stored bindings, which is a shell change
 * and a store; the reference surface is worth having before either exists, and
 * shipping the reference first is what the survey recommends (item #10).
 * Nothing here pretends otherwise: no row looks pressable, and the pane says in
 * one sentence that the chords are fixed.
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
};

/**
 * The table, as rows.
 *
 * `bindings` is a parameter so the derivation is testable against a table this
 * app does not ship — including one carrying an id `NAMES` has never heard of,
 * which must still produce a row rather than throwing.
 */
export function keybindingRows(
  platform: KeyCapPlatform,
  bindings: readonly CommandKeyBinding[] = COMMAND_KEY_BINDINGS,
): KeybindingRow[] {
  return bindings.map((binding) => {
    // The nine jumps are generated in the table and named by their number,
    // so they are named by their number here too rather than nine map entries.
    const named = binding.jump
      ? { namespace: "Rail", command: `Jump to conversation ${binding.jump}` }
      : // An id with no entry falls back to the menu's own label: a row that
        // reads a little like a menu item beats a binding that is not listed.
        (NAMES[binding.id] ?? { namespace: "Application", command: binding.label });
    return { id: binding.id, title: `${named.namespace}: ${named.command}`, caps: keyCaps(binding.accelerator, platform) };
  });
}

/** One key, in a box. `kbd` because that is what it is. */
function Caps({ caps }: { caps: readonly string[] }) {
  return (
    <span className="flex items-center gap-1">
      {caps.map((cap, at) => (
        <kbd
          key={`${cap}-${at}`}
          className="inline-flex min-w-5 items-center justify-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem] leading-none text-muted-foreground"
        >
          {cap}
        </kbd>
      ))}
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
      description="Fixed for now — rebinding needs the app menu to rebuild itself from stored keys, which is not built yet."
      // The plain count the reference puts on its section header. It is a fact
      // about the list, so it reads in the register the rest of the machine's
      // figures do rather than as a badge.
      action={<span className="text-xs tabular-nums text-muted-foreground">{rows.length} bindings</span>}
    >
      {rows.map((row) => (
        <Row key={row.id} label={row.title} icon={KeyboardIcon} control={<Caps caps={row.caps} />} />
      ))}
    </SettingsGroup>
  );
}

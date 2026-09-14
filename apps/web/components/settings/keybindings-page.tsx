"use client";

/**
 * EVERY KEY THIS APP ANSWERS TO, AND THE PLACE YOU CHANGE ONE.
 *
 * The table has been alive since issue #16 — `apps/desktop/command-keys.js` is
 * what builds the Electron menu's accelerators AND what the renderer matches a
 * keydown against — and until #367 there was no screen that could change it. The
 * old pane read twelve fixed rows out and said, in effect, "press it and find
 * out". The blocker it named was real: rebinding means the application menu
 * rebuilding its accelerators from a stored map, which is a shell change and a
 * store. Both exist now (`lib/commands.ts`, `main.js`), so the rows are live.
 *
 * A ROW RECORDS RATHER THAN PARSES. Click the chord, press the new one, done —
 * no text field spelling out "CommandOrControl+Shift+D", which is a format the
 * Electron menu wants and no reader should have to learn. Escape leaves the row
 * alone; Backspace clears it, because "no chord" is a real answer and a person
 * who wants ⌘K back for their browser needs a way to say so.
 *
 * CONFLICTS ARE FLAGGED, NEVER REFUSED. Two commands on one chord is a state the
 * store can hold and the dispatcher resolves deterministically (registry order),
 * so the pane says which rows collide and lets the person finish the swap they
 * were halfway through. Refusing the first half of a swap is how a rebinding UI
 * becomes unusable.
 *
 * THE NINE JUMPS ARE ONE ROW. ⌘1 through ⌘9 are one idea generated nine times,
 * and nine rows of it was three quarters of this pane saying the same thing.
 * Recording on that row takes the MODIFIERS off whatever digit you press and
 * gives every slot its own — because nine rows that could disagree would be nine
 * rows again, wearing a fold.
 *
 * THE REGISTRY IS THE SOURCE, NOT A COPY OF IT. Every row below is derived from
 * `COMMANDS`, so a command added to that file appears here without anybody
 * remembering to — which is the failure mode a hand-written shortcut list has,
 * and the reason Telar has never had one.
 */

import { useEffect, useState } from "react";
import { KeyboardIcon } from "lucide-react";
import {
  COMMANDS,
  COMMAND_GROUPS,
  chordForEvent,
  defaultKeymap,
  jumpCommands,
  keymapConflicts,
  normalizeChord,
  restoreDefaultKeymap,
  setChord,
  setChordCapture,
  setChords,
  type Command,
  type CommandGroup,
  type CommandId,
  type Keymap,
} from "@/lib/commands";
import { keyCaps, useKeyCapPlatform, type KeyCapPlatform } from "@/lib/key-caps";
import { useKeymap } from "@/lib/use-command-keys";
import { Row, SettingsGroup, useRestoreDefaults } from "./settings-shell";

/** THE FORMATTER MOVED TO `lib/key-caps.ts` (#401). This pane was the only
 *  surface that drew a chord until every control bound to one started showing
 *  its caps while ⌘ is held; a settings page is not where a rail row should
 *  import them from. Only the rows below stayed. */

export type KeybindingRow = {
  /** A command id, or "jump" for the folded range. */
  id: string;
  /** The command ids this row rebinds — nine of them on the folded jump row. */
  commandIds: CommandId[];
  group: CommandGroup;
  /** `Namespace: Command`, the reference's own row title. */
  title: string;
  chord: string;
  caps: string[];
  /** The far end of a FOLDED RANGE. `⌘1–⌘9` is one row rather than nine, so the
   *  row needs a second chord to draw after the dash. */
  through?: string[];
  /** Other rows on this chord, by title — empty when there is no collision. */
  conflicts: string[];
  /** False when this row is already at the registry's own answer. */
  changed: boolean;
};

/** What a command is called HERE. The registry's `label` is the Electron menu
 *  item's text, so it is capitalised the way a File menu is ("New Conversation");
 *  a settings row is a sentence, not a menu item. */
function rowTitle(command: Command): string {
  return command.label.replace(/…$/, "");
}

/**
 * The registry, as rows.
 *
 * `commands` and `keymap` are parameters so the derivation is testable against a
 * registry this app does not ship — including one whose chords collide, which
 * must produce flagged rows rather than throwing.
 *
 * THE JUMPS FOLD, AND THE FOLD IS DERIVED TOO. The range is taken from the
 * LOWEST and HIGHEST jump the registry carries rather than hardcoding 1 and 9,
 * so a tenth slot would widen the row instead of going unlisted. A registry with
 * exactly one jump folds to nothing and keeps its ordinary row.
 */
export function keybindingRows(platform: KeyCapPlatform, keymap: Keymap, commands: readonly Command[] = COMMANDS): KeybindingRow[] {
  const defaults = defaultKeymap();
  const conflicts = keymapConflicts(keymap);
  const titleOf = (id: CommandId) => {
    const command = commands.find((entry) => entry.id === id);
    return command ? rowTitle(command) : id;
  };

  const jumps = commands.filter((command) => command.jump).sort((left, right) => (left.jump ?? 0) - (right.jump ?? 0));
  const folded = jumps.length > 1 ? jumps : [];
  const first = folded[0];
  const last = folded[folded.length - 1];

  const rows: KeybindingRow[] = [];
  for (const command of commands) {
    const chord = normalizeChord(keymap[command.id] ?? "");
    if (command.jump && folded.length > 0) {
      // One row for the whole run, emitted where the first of them sat so the
      // list keeps the registry's own order.
      if (command !== first) continue;
      const lastChord = normalizeChord(keymap[last!.id] ?? "");
      // The fold's own conflicts are the union of its slots' — a ⌘3 that now
      // collides with something has to say so on the only row that draws it.
      const shared = new Set<string>();
      for (const jump of folded) for (const other of conflicts[jump.id] ?? []) shared.add(titleOf(other));
      rows.push({
        id: "jump",
        commandIds: folded.map((jump) => jump.id),
        group: command.group,
        title: `Jump to conversation ${first.jump}–${last!.jump}`,
        chord,
        caps: keyCaps(chord, platform),
        ...(lastChord ? { through: keyCaps(lastChord, platform) } : {}),
        conflicts: [...shared].filter((title) => !folded.some((jump) => titleOf(jump.id) === title)),
        changed: folded.some((jump) => normalizeChord(keymap[jump.id] ?? "") !== defaults[jump.id]),
      });
      continue;
    }
    rows.push({
      id: command.id,
      commandIds: [command.id],
      group: command.group,
      title: rowTitle(command),
      chord,
      caps: keyCaps(chord, platform),
      conflicts: (conflicts[command.id] ?? []).map(titleOf),
      changed: chord !== defaults[command.id],
    });
  }
  return rows;
}

/**
 * The chord a recording keydown means, or null while it is only modifiers.
 *
 * ESCAPE IS NOT RECORDABLE HERE and that is a deliberate cost: it is the one key
 * a person will reach for to back out of a recorder, and a recorder that swallowed
 * it would have no exit. Bare Escape cancels; ⌥Escape or ⇧Escape still records,
 * so the key is not lost to the registry, only its unmodified press.
 */
export function recordedChord(event: {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}): { kind: "chord"; chord: string } | { kind: "cancel" } | { kind: "clear" } | { kind: "waiting" } {
  const bare = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
  if (bare && event.key === "Escape") return { kind: "cancel" };
  if (bare && (event.key === "Backspace" || event.key === "Delete")) return { kind: "clear" };
  const chord = chordForEvent(event);
  return chord ? { kind: "chord", chord } : { kind: "waiting" };
}

/** The chord each jump slot takes from one recorded press: the modifiers you
 *  used, and the slot's own digit. Null when the press was not a digit, which is
 *  the only way this row can stay one binding rather than nine. */
export function jumpChordsFrom(chord: string, slots: readonly Command[]): Partial<Record<CommandId, string>> | null {
  const parts = chord.split("+");
  const key = parts[parts.length - 1] ?? "";
  if (!/^[0-9]$/.test(key)) return null;
  const modifiers = parts.slice(0, -1);
  const chords: Partial<Record<CommandId, string>> = {};
  for (const slot of slots) chords[slot.id] = normalizeChord([...modifiers, String(slot.jump)].join("+"));
  return chords;
}

/** One key, in a box. `kbd` because that is what it is. */
function Caps({ caps, through }: { caps: readonly string[]; through?: readonly string[] }) {
  const box = (cap: string, at: number) => (
    <kbd
      key={`${cap}-${at}`}
      className="inline-flex min-w-5 items-center justify-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-2xs leading-none text-muted-foreground"
    >
      {cap}
    </kbd>
  );
  if (caps.length === 0) return <span className="text-2xs text-muted-foreground/60">Unbound</span>;
  return (
    <span className="flex items-center gap-1">
      {caps.map(box)}
      {through && (
        <>
          {/* An en dash rather than a third cap: the range is between the two
              chords, not a key you press. */}
          <span className="px-0.5 text-2xs text-muted-foreground/70">–</span>
          {through.map(box)}
        </>
      )}
    </span>
  );
}

/**
 * The pressable chord.
 *
 * THE RECORDER IS THE BUTTON, not a dialog over it: a modal to change one chord
 * is three gestures where the row already has one, and it hides the list you are
 * checking for a collision. Keydown is captured on the button itself while it
 * has focus, so nothing else in the app sees the press — including the app's own
 * command keys, which would otherwise fire the very command you are rebinding.
 */
function ChordButton({
  row,
  recording,
  onRecord,
  onStart,
  onStop,
}: {
  row: KeybindingRow;
  recording: boolean;
  onRecord: (chord: string) => void;
  onStart: () => void;
  onStop: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onStart}
      onBlur={onStop}
      onKeyDown={(event) => {
        if (!recording) return;
        // Space and Enter would otherwise re-activate the button rather than be
        // recorded, and every chord below has to be kept from the rest of the app.
        event.preventDefault();
        event.stopPropagation();
        const recorded = recordedChord(event.nativeEvent);
        if (recorded.kind === "waiting") return;
        if (recorded.kind === "cancel") {
          onStop();
          return;
        }
        onRecord(recorded.kind === "clear" ? "" : recorded.chord);
      }}
      aria-label={recording ? `Press the new chord for ${row.title}` : `Change the chord for ${row.title}`}
      className={
        recording
          ? "rounded-md border border-dashed border-primary/60 bg-primary/5 px-2 py-1 text-2xs text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring"
          : "rounded-md border border-transparent px-2 py-1 transition-colors outline-none hover:border-border hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
      }
    >
      {recording ? "Press a chord…" : <Caps caps={row.caps} {...(row.through ? { through: row.through } : {})} />}
    </button>
  );
}

export function KeybindingsPage() {
  // Which keyboard, read after the first paint — see `useKeyCapPlatform`. The
  // deferral lived here until #401 gave four other surfaces the same question.
  const platform = useKeyCapPlatform();

  const keymap = useKeymap();
  const [recording, setRecording] = useState<string>();
  const [rejected, setRejected] = useState<string>();
  /**
   * WHILE A ROW IS ARMED, NOTHING ELSE MAY ANSWER THE NEXT PRESS — not the app's
   * own dispatcher and not the shell's menu, which on macOS would swallow the
   * keydown before the page ever saw it. See `setChordCapture`.
   *
   * Driven from an effect off the recording state so every way OUT of recording
   * — Escape, blur, a recorded chord, Restore defaults, unmounting the pane
   * mid-record — releases it. A cleanup that lived on the button would miss the
   * last of those and leave the menu accelerator-less until relaunch.
   */
  useEffect(() => {
    setChordCapture(recording !== undefined);
    return () => setChordCapture(false);
  }, [recording]);
  useRestoreDefaults(() => {
    setRecording(undefined);
    setRejected(undefined);
    restoreDefaultKeymap();
  });

  const rows = keybindingRows(platform, keymap);
  const slots = jumpCommands();

  const record = (row: KeybindingRow, chord: string) => {
    setRecording(undefined);
    if (row.id === "jump") {
      // Clearing the fold clears all nine; otherwise the digit decides.
      if (chord === "") {
        setRejected(undefined);
        setChords(Object.fromEntries(slots.map((slot) => [slot.id, ""])));
        return;
      }
      const chords = jumpChordsFrom(chord, slots);
      if (!chords) {
        setRejected(row.id);
        return;
      }
      setRejected(undefined);
      setChords(chords);
      return;
    }
    setRejected(undefined);
    setChord(row.commandIds[0]!, chord);
  };

  const revert = (row: KeybindingRow) => {
    const defaults = defaultKeymap();
    setRejected(undefined);
    setChords(Object.fromEntries(row.commandIds.map((id) => [id, defaults[id]])));
  };

  return (
    <>
      {/* THE ONE INSTRUCTION THIS PANE NEEDS, and it needs one now: a row that
          became pressable this release looks exactly like the row that was not.
          Two sentences over four cards, rather than a hint repeated on
          twenty-odd rows. */}
      <div className="mb-6 px-4">
        <h4 className="font-heading text-xs-plus font-normal tracking-tight text-foreground/70">Keyboard shortcuts</h4>
        <p className="mt-1 text-xs text-muted-foreground">
          Click a chord and press the new one. Backspace clears it, Escape leaves it alone, and Restore defaults puts every one of them
          back.
        </p>
      </div>
      {COMMAND_GROUPS.map((group) => {
        const groupRows = rows.filter((row) => row.group === group);
        if (groupRows.length === 0) return null;
        return (
          <SettingsGroup key={group} title={group} description={GROUP_BLURBS[group]}>
            {groupRows.map((row) => (
              <Row
                key={row.id}
                id={`keybindings-${row.id}`}
                label={row.title}
                icon={KeyboardIcon}
                {...(row.changed ? { onRevert: () => revert(row) } : {})}
                {...(rejected === row.id
                  ? { error: "The nine jumps share one set of modifiers — press a chord ending in a digit." }
                  : row.conflicts.length > 0
                    ? { error: `Also ${listed(row.conflicts)}. The first in this list wins.` }
                    : {})}
                control={
                  <ChordButton
                    row={row}
                    recording={recording === row.id}
                    onStart={() => {
                      setRejected(undefined);
                      setRecording(row.id);
                    }}
                    onStop={() => setRecording((current) => (current === row.id ? undefined : current))}
                    onRecord={(chord) => record(row, chord)}
                  />
                }
              />
            ))}
          </SettingsGroup>
        );
      })}
    </>
  );
}

/** What the group is FOR, in one line — the same job the hint does on a row. */
const GROUP_BLURBS: Record<CommandGroup, string> = {
  Conversation: "The conversation in front of you, and starting another one.",
  Rail: "Moving around the list on the left.",
  Panel: "The surfaces on the right, and which one is showing.",
  Application: "The app itself.",
};

/** "Open Diff" / "Open Diff and Open Editor" / "Open Diff, Open Editor and X". */
function listed(titles: readonly string[]): string {
  if (titles.length <= 1) return titles[0] ?? "";
  return `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
}

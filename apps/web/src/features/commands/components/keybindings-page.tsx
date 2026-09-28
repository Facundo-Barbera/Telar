"use client";

import { useEffect, useState } from "react";
import { KeyboardIcon } from "lucide-react";
import { COMMANDS, COMMAND_GROUPS, chordForEvent, defaultKeymap, jumpCommands, keymapConflicts, normalizeChord, restoreDefaultKeymap, setChord, setChordCapture, setChords, type Command, type CommandGroup, type CommandId, type Keymap } from "../commands";
import { useKeymap } from "../use-command-keys";
import { keyCaps, useKeyCapPlatform, type KeyCapPlatform } from "@/lib/key-caps";
import { Row, SettingsGroup, useRestoreDefaults } from "@/features/settings";

export type KeybindingRow = {
  id: string;
  commandIds: CommandId[];
  group: CommandGroup;
  title: string;
  hint?: string;
  chord: string;
  caps: string[];
  through?: string[];
  conflicts: string[];
  changed: boolean;
};

function rowTitle(command: Command): string {
  return command.label.replace(/…$/, "");
}

const JUMP_HINT = "The Nth entry in the rail, top to bottom as drawn — shelved rows and folded groups skipped.";

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
      if (command !== first) continue;
      const lastChord = normalizeChord(keymap[last!.id] ?? "");
      const shared = new Set<string>();
      for (const jump of folded) for (const other of conflicts[jump.id] ?? []) shared.add(titleOf(other));
      rows.push({
        id: "jump",
        commandIds: folded.map((jump) => jump.id),
        group: command.group,
        title: `Jump to conversation ${first.jump}–${last!.jump}`,
        hint: JUMP_HINT,
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

export function jumpChordsFrom(chord: string, slots: readonly Command[]): Partial<Record<CommandId, string>> | null {
  const parts = chord.split("+");
  const key = parts[parts.length - 1] ?? "";
  if (!/^[0-9]$/.test(key)) return null;
  const modifiers = parts.slice(0, -1);
  const chords: Partial<Record<CommandId, string>> = {};
  for (const slot of slots) chords[slot.id] = normalizeChord([...modifiers, String(slot.jump)].join("+"));
  return chords;
}

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
          <span className="px-0.5 text-2xs text-muted-foreground/70">–</span>
          {through.map(box)}
        </>
      )}
    </span>
  );
}

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
  const platform = useKeyCapPlatform();

  const keymap = useKeymap();
  const [recording, setRecording] = useState<string>();
  const [rejected, setRejected] = useState<string>();
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
      <div className="mb-6 px-4">
        <h4 className="font-heading text-xs-plus font-semibold tracking-tight text-foreground">Keyboard shortcuts</h4>
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
                {...(row.hint ? { hint: row.hint } : {})}
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

const GROUP_BLURBS: Record<CommandGroup, string> = {
  Conversation: "The conversation in front of you, and starting another one.",
  Rail: "Moving around the list on the left.",
  Panel: "The surfaces on the right, and which one is showing.",
  Application: "The app itself.",
};

function listed(titles: readonly string[]): string {
  if (titles.length <= 1) return titles[0] ?? "";
  return `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
}

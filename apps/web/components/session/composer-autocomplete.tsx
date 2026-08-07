"use client";

// The composer's two autocomplete menus — `/` slash commands and `@` file
// mentions — lifted out of session-view.tsx whole. Both are driven by the SAME
// textarea and the same controlled value, which is why they live together: the
// keydown handler below has to decide which menu owns a key press, and that
// decision is only correct if one place can see both menus at once.
//
// Everything here is composer-local: nothing reads the transcript, the turn
// status, or any session state. The one wire back out is `setSdkSlashCommands`,
// which the session's SSE reducer calls when a turn's "session" event reports
// what the live harness actually offers.

import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePromptInputController } from "@/components/ai-elements/prompt-input";
import { Badge } from "@/components/ui/badge";
import { cachedJson } from "@/lib/client-json-cache";
import { cn } from "@/lib/utils";

// Both shapes are MIRRORED, not imported. The module that produces them
// (lib/project-files.ts) reaches node:child_process and node:fs to read the
// repo. `import type` would erase cleanly today, but the day someone drops the
// `type` keyword the whole file index follows it into the client bundle — and a
// local shape cannot be de-erased by accident.
export type ProjectCommand = {
  name: string;
  description: string;
  kind: "command" | "skill";
};

export type ProjectFile = { path: string; name: string };

// The `@token` the cursor is sitting at the end of. Anchored on
// start-of-string-or-whitespace so `foo@bar` and an email never open the menu,
// and stopping at the next whitespace so a COMPLETED mention closes it again.
// Module scope, and no /g flag — so it carries no lastIndex between calls and
// is safe to share across every render and both readers below.
const MENTION_AT_CARET = /(?:^|\s)@([^\s@]*)$/;

// Stable empty list, so "no mention is being typed" is the SAME array every
// render and cannot re-trigger a memo or an effect downstream of it.
const NO_FILES: ProjectFile[] = [];

export type ComposerAutocomplete = ReturnType<typeof useComposerAutocomplete>;

export function useComposerAutocomplete({
  project,
  provider,
}: {
  project: string;
  provider: "claude" | "codex";
}) {
  const textInput = usePromptInputController().textInput;

  // `projectCommands` comes from the project's .claude/commands scan (has
  // descriptions); `sdkSlashCommands` narrows it to what the live SDK session
  // actually reports once a turn's "session" event arrives (that list also
  // contains built-ins we deliberately don't show).
  const [projectCommands, setProjectCommands] = useState<ProjectCommand[]>([]);
  const [sdkSlashCommands, setSdkSlashCommands] = useState<string[] | null>(null);
  const [menuDismissed, setMenuDismissed] = useState(false);
  // HIGHLIGHT IS TAGGED WITH THE QUERY IT WAS CHOSEN UNDER, so a query change
  // resets it by DERIVATION rather than by an effect that calls setState. Both
  // menus do this (see `mentionSelection` below) and both used to do it with a
  // reset effect, which is a cascading render on every keystroke — and, in the
  // 4k-line component this was extracted from, one the compiler's lint had
  // stopped flagging because it gave up analyzing a function that size.
  const [selection, setSelection] = useState({ query: "", index: 0 });

  // `caret` is tracked because — unlike the slash menu, which only ever fires
  // when the WHOLE value starts with "/" — a mention is typed mid-sentence, so
  // the query is whatever `@token` the cursor currently sits at the end of.
  // Null means "not measured yet", which reads as end-of-text.
  const [caret, setCaret] = useState<number | null>(null);
  const [mentionResult, setMentionResult] = useState<ProjectFile[]>([]);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [mentionSelection, setMentionSelection] = useState({ query: "", index: 0 });

  // The composer textarea, and the caret position to restore into it once React
  // has committed a programmatic edit. Accepting a mention rewrites the value
  // through the controlled `setInput`, which puts the cursor at the END of the
  // new text — so completing `@rou` mid-sentence would drop the human's cursor
  // after the rest of their sentence rather than after the path they just
  // inserted. The DOM write has to happen after the commit, hence the ref pair
  // plus the effect below rather than a straight-line assignment.
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingCaretRef = useRef<number | null>(null);

  useEffect(() => {
    const pos = pendingCaretRef.current;
    if (pos === null) return;
    pendingCaretRef.current = null;
    const el = composerRef.current;
    if (!el) return;
    // focus() because accepting by MOUSE leaves the textarea unfocused; the
    // mousedown handler on the menu item prevents the blur, but a click that
    // landed before the composer ever had focus still needs it back.
    el.focus();
    el.setSelectionRange(pos, pos);
  }, [textInput.value]);

  // Non-200 (including a project scan with no .claude/commands dir, which the
  // endpoint itself answers with an empty list) is treated as "no commands" —
  // autocomplete is a nicety, never worth an error UI.
  useEffect(() => {
    let cancelled = false;
    cachedJson<{ commands?: ProjectCommand[] }>(
      `/api/projects/${encodeURIComponent(project)}/commands`,
      { maxAgeMs: 60_000 },
    )
      .then((data: { commands?: ProjectCommand[] }) => {
        if (!cancelled) setProjectCommands(data.commands ?? []);
      })
      .catch(() => {
        if (!cancelled) setProjectCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  // Merge project's scanned commands+skills with what the live SDK session
  // actually reports (once known) — the SDK's slash_commands list includes
  // repo skills alongside .claude/commands entries, so a name match here
  // keeps skills exactly like commands. The SDK list also carries built-ins
  // and plugin commands we don't advertise, so this only ever narrows, never
  // adds names the project scan didn't already find.
  const availableCommands = useMemo(() => {
    // Codex sessions don't run slash commands (a Claude-session feature today),
    // so a Codex session offers none — regardless of what .claude/commands the
    // repo has. The menu still opens (below) to say so honestly, rather than
    // listing commands that would only be sent as literal text.
    if (provider === "codex") return [];
    if (sdkSlashCommands === null) return projectCommands;
    const known = new Set(sdkSlashCommands);
    return projectCommands.filter((c) => known.has(c.name));
  }, [projectCommands, sdkSlashCommands, provider]);

  const slashQuery =
    textInput.value.startsWith("/") && !textInput.value.includes(" ")
      ? textInput.value.slice(1)
      : null;

  const filteredCommands = useMemo(() => {
    if (slashQuery === null) return [];
    const q = slashQuery.toLowerCase();
    return availableCommands.filter((c) => c.name.toLowerCase().startsWith(q));
  }, [availableCommands, slashQuery]);

  // The menu also opens on a genuinely empty project (zero commands AND zero
  // skills) so it can show the "how to add some" hint instead of just silently
  // doing nothing — that read as a broken feature to users. A query that merely
  // doesn't match anything (project has commands, none start with what's typed)
  // still closes the menu as before.
  const slashMenuOpen =
    slashQuery !== null &&
    !menuDismissed &&
    (filteredCommands.length > 0 ||
      projectCommands.length === 0 ||
      // Codex: open even with a non-empty project scan, to show the honest
      // "commands are a Claude-session feature" copy instead of nothing.
      provider === "codex");

  // The highlight only survives while the query it was made under does — so it
  // can never point past a list that shrank under it.
  const selectedIndex = selection.query === (slashQuery ?? "") ? selection.index : 0;
  const moveSelection = (next: (i: number) => number) =>
    setSelection({ query: slashQuery ?? "", index: next(selectedIndex) });

  const acceptCommand = useCallback(
    (c: ProjectCommand) => {
      textInput.setInput(`/${c.name} `);
    },
    [textInput],
  );

  const mentionQuery = useMemo(() => {
    const value = textInput.value;
    return MENTION_AT_CARET.exec(value.slice(0, caret ?? value.length))?.[1] ?? null;
  }, [textInput.value, caret]);

  // The list belongs to the mention being typed, so it empties the moment the
  // mention ends — derived, not cleared by an effect. While the mention is
  // still being typed the PREVIOUS keystroke's files stay up until the debounce
  // lands, which is what keeps the menu from flashing empty between letters.
  const mentionFiles = mentionQuery === null ? NO_FILES : mentionResult;
  const mentionMenuOpen = mentionQuery !== null && !mentionDismissed && mentionFiles.length > 0;
  const mentionIndex = mentionSelection.query === mentionQuery ? mentionSelection.index : 0;
  const moveMention = (next: (i: number) => number) =>
    setMentionSelection({ query: mentionQuery ?? "", index: next(mentionIndex) });

  // Re-query on every keystroke of the mention, debounced.
  useEffect(() => {
    if (mentionQuery === null) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void fetch(
        `/api/projects/${encodeURIComponent(project)}/files?q=${encodeURIComponent(mentionQuery)}`,
        { signal: abort.signal },
      )
        .then((r) => (r.ok ? r.json() : { files: [] }))
        .then((body: { files?: ProjectFile[] }) => setMentionResult(body.files ?? []))
        .catch(() => {
          /* aborted or offline — leave the previous list rather than flashing empty */
        });
    }, 120);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [mentionQuery, project]);

  const acceptMention = useCallback(
    (file: ProjectFile) => {
      const value = textInput.value;
      const pos = caret ?? value.length;
      const match = MENTION_AT_CARET.exec(value.slice(0, pos));
      if (!match) return;
      // Replace from the "@" itself — match[1] is the query, so the "@" sits one
      // character before it — and leave a trailing space so the next word does
      // not extend the path that was just completed.
      const start = pos - match[1].length - 1;
      const next = `${value.slice(0, start)}@${file.path} ${value.slice(pos)}`;
      // "@" + path + the trailing space — where the human should carry on typing.
      const after = start + file.path.length + 2;
      textInput.setInput(next);
      pendingCaretRef.current = after;
      setCaret(after);
      setMentionDismissed(true);
    },
    [textInput, caret],
  );

  // No focus() anywhere here — navigation and acceptance are driven entirely
  // by the textarea's own keydown, so the textarea never loses focus.
  const onComposerKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // The caret moves on arrows/home/end without the value changing, so onChange
    // alone would leave `caret` stale and the mention query measured against the
    // wrong slice. Read it AFTER the browser has applied the key, hence the
    // deferral — currentTarget is captured first because React pools nothing
    // here but the event object is still not safe to close over.
    const el = e.currentTarget;
    queueMicrotask(() => setCaret(el.selectionStart));

    // The mention menu takes the keys FIRST when it is open: both menus are
    // driven by the same textarea, and a "/" command can only ever be at the
    // very start of the value, so the two can never both be open on the same
    // token — but if that ever changes, the one the cursor is actually inside
    // should win, and that is this one.
    if (mentionMenuOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionDismissed(true);
        return;
      }
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          moveMention((i) => (i + 1) % mentionFiles.length);
          return;
        case "ArrowUp":
          e.preventDefault();
          moveMention((i) => (i - 1 + mentionFiles.length) % mentionFiles.length);
          return;
        case "Enter":
        case "Tab":
          e.preventDefault();
          acceptMention(mentionFiles[mentionIndex] ?? mentionFiles[0]);
          return;
      }
    }

    if (!slashMenuOpen) return;
    // Escape always dismisses, including the empty-project hint panel. The
    // rest only make sense once there's something to navigate/accept — the
    // hint panel has no items, so leave those keys to behave normally
    // (e.g. Enter still submits the composer).
    if (e.key === "Escape") {
      e.preventDefault();
      setMenuDismissed(true);
      return;
    }
    if (filteredCommands.length === 0) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveSelection((i) => (i + 1) % filteredCommands.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveSelection((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
        break;
      case "Enter":
      case "Tab":
        e.preventDefault();
        acceptCommand(filteredCommands[selectedIndex] ?? filteredCommands[0]);
        break;
    }
  };

  // What the textarea itself has to do on every edit/click for the two menus
  // to stay honest: a fresh keystroke un-dismisses, and the caret is re-read.
  // Spread onto the textarea so a future menu can add to it in one place
  // instead of every call site growing another handler.
  const onComposerInput = (e: { currentTarget: HTMLTextAreaElement }) => {
    setMenuDismissed(false);
    setMentionDismissed(false);
    setCaret(e.currentTarget.selectionStart);
  };

  return {
    composerRef,
    // Slash commands
    projectCommands,
    slashMenuOpen,
    filteredCommands,
    selectedIndex,
    acceptCommand,
    // The session's SSE reducer owns this: a turn's "session" event is the only
    // thing that knows what the live harness actually offers.
    setSdkSlashCommands,
    // File mentions
    mentionMenuOpen,
    mentionFiles,
    mentionIndex,
    acceptMention,
    // Textarea wiring
    onComposerKeyDown,
    onComposerInput,
    setCaret,
  };
}

/**
 * Both menus, rendered above the composer. They are mutually exclusive in
 * practice (a `/` command only ever occupies the whole value, a mention never
 * does) but both are rendered from one place so the absolute positioning and
 * the popover chrome cannot drift apart between them.
 */
export function ComposerAutocompleteMenus({
  ac,
  provider,
}: {
  ac: ComposerAutocomplete;
  provider: "claude" | "codex";
}) {
  return (
    <>
      {ac.slashMenuOpen && (
        <div className="absolute inset-x-4 bottom-full z-10 mb-2 max-h-64 overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
          {ac.filteredCommands.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
              {provider === "codex"
                ? "Slash commands are a Claude-session feature — Codex sessions don't run them today."
                : "No commands — add .claude/commands/*.md or skills to this repo."}
            </p>
          ) : (
            ac.filteredCommands.map((c, i) => (
              <button
                type="button"
                key={c.name}
                // preventDefault on mousedown keeps focus on the textarea — no
                // .focus() call, just skipping the browser's default click-to-
                // focus so the composer stays the active element.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => ac.acceptCommand(c)}
                className={cn(
                  "flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left",
                  i === ac.selectedIndex
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent hover:text-accent-foreground",
                )}
              >
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-xs">/{c.name}</span>
                  {c.kind === "skill" && (
                    <Badge variant="outline" className="px-1 py-0 text-[10px]">
                      skill
                    </Badge>
                  )}
                </span>
                {c.description && (
                  <span className="text-[11px] text-muted-foreground">{c.description}</span>
                )}
              </button>
            ))
          )}
        </div>
      )}
      {ac.mentionMenuOpen && (
        <div className="absolute inset-x-4 bottom-full z-10 mb-2 max-h-64 overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
          {ac.mentionFiles.map((f, i) => (
            <button
              type="button"
              key={f.path}
              // Same trick the slash menu uses: preventDefault on mousedown
              // keeps focus on the textarea, so accepting an item never costs
              // the composer its cursor.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => ac.acceptMention(f)}
              className={cn(
                "flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left",
                i === ac.mentionIndex
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <span className="shrink-0 font-mono text-xs">{f.name}</span>
              <span className="min-w-0 flex-1 truncate text-right text-[11px] text-muted-foreground">
                {f.path}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

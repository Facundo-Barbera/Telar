"use client";

/**
 * LOOKS — save the whole appearance, wear it back, send it to someone.
 *
 * Everything else on this pane edits ONE axis. This group is the axis-free
 * one: a card here is the theme AND the backdrop AND the accent AND the type
 * AND the translucency strength, captured together (lib/looks.ts states what
 * is in the bundle and, just as importantly, why the desktop translucency
 * TOGGLE is not).
 *
 * IT IS A STRIP ACROSS THE TOP OF THE EDITOR, because a Look is the biggest
 * unit on the pane: someone arriving to change how the app feels should be
 * offered the whole answer before the parts of it. Everything below — the
 * stage, the designer, the inspector — is how you BUILD one. The strip scrolls
 * sideways rather than growing a second row, so the editor underneath keeps
 * its height whether the shelf holds one look or twelve.
 *
 * WEARING ONE IS A LIVE CHANGE, deliberately: it is the only control here that
 * says "I want this now" rather than "I am trying something". Everything the
 * studio drafts goes the other way — onto the stage, and into the app only on
 * Apply, which lands here as a new card.
 *
 * THE CARD IDIOM IS THE THEME LIBRARY'S, EXACTLY: same ring, same hover-
 * revealed ghost actions, same download helper, same inline error line on the
 * Row's hint. A Look card is a different noun in the same grammar, and having
 * it look like a second design would suggest it behaves like one.
 *
 * WEARING A LOOK INSTALLS ITS THEME as a real custom theme in the library
 * (`look-${id}`), rather than writing the compiled CSS behind theme-palettes'
 * back. That keeps one owner for the stylesheet cache, and it means the theme
 * you just put on is immediately editable in the group below — wear, then
 * tweak, then save a new Look.
 */

import { useRef, useState } from "react";
import { CheckIcon, DownloadIcon, Trash2Icon, UploadIcon } from "lucide-react";
import {
  applyLook,
  captureLook,
  lookFilename,
  lookThemeId,
  newLookId,
  parseLookFile,
  serializeLook,
  upsertLook,
  useLooks,
  writeLooks,
  LOOKS_FULL_MESSAGE,
  LOOKS_QUOTA_MESSAGE,
  type Look,
} from "@/lib/looks";
import { useAppearance } from "@/lib/appearance";
import { useThemeLibrary } from "@/lib/theme-palettes";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Row, SettingsGroup } from "./settings-shell";

/** What the strip says under the label — the one word that tells you whether
 *  this Look brings a wallpaper with it. */
const BACKDROP_LABEL: Record<Look["backdrop"]["kind"], string> = {
  none: "No backdrop",
  gradient: "Gradient",
  "custom-gradient": "Custom gradient",
  image: "Image",
  scene: "Composed scene",
};

function downloadFile(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking synchronously can abort the download; give the stream a moment.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * The strip: the Look's two CANVAS colours, light beside dark. Not the theme
 * library's orbs — those are a control for wearing one half, and a Look's
 * halves are not separable. Two flat chips read as "one thing with a day and a
 * night", which is what a Look is.
 */
function LookStrip({ look }: { look: Look }) {
  return (
    <div className="flex size-9 shrink-0 overflow-hidden rounded-lg ring-1 ring-foreground/15">
      <span className="flex-1" style={{ background: look.theme.light.background }} />
      <span className="flex-1" style={{ background: look.theme.dark.background }} />
    </div>
  );
}

function LookCard({ look, active, onWear, onExport, onRemove }: { look: Look; active: boolean; onWear: () => void; onExport: () => void; onRemove: () => void }) {
  return (
    <div
      className={cn(
        // A STRIP, NOT A GRID: the shelf sits across the top of the editor now,
        // where it is a place to start from rather than a section to read. A
        // fixed width keeps the cards a scannable rank instead of a ragged one.
        "group flex w-60 shrink-0 cursor-pointer items-center gap-3 rounded-xl bg-card p-3 ring-1 ring-foreground/10 transition-colors hover:bg-accent/50",
        active && "ring-2 ring-primary",
      )}
      onClick={onWear}
      role="button"
      title={`Wear ${look.label}`}
      aria-label={`Wear ${look.label}`}
      aria-pressed={active}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onWear();
        }
      }}
    >
      <LookStrip look={look} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <span className="truncate">{look.label}</span>
          {active && <CheckIcon className="size-3.5 shrink-0 text-primary" />}
        </div>
        <div className="text-[0.6875rem] text-muted-foreground">{BACKDROP_LABEL[look.backdrop.kind]}</div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <Button size="icon-sm" variant="ghost" title="Export" aria-label={`Export ${look.label}`} onClick={(event) => (event.stopPropagation(), onExport())}>
          <DownloadIcon />
        </Button>
        <Button size="icon-sm" variant="ghost" title="Delete" aria-label={`Delete ${look.label}`} onClick={(event) => (event.stopPropagation(), onRemove())}>
          <Trash2Icon />
        </Button>
      </div>
    </div>
  );
}

export function LooksSection() {
  const { activeId, saveCustom, setActive } = useThemeLibrary();
  const { setAppearance } = useAppearance();
  const looks = useLooks();
  const [naming, setNaming] = useState<string>();
  // The MESSAGE, not a flag: "full", "will not fit", and "not a look file" are
  // three different things to do about it (theme-library.tsx's idiom).
  const [error, setError] = useState<string | false>(false);
  const fileInput = useRef<HTMLInputElement>(null);

  /** One place where a list becomes storage, so a refusal can never leave the
   *  grid showing something that was not written — writeLooks puts the previous
   *  value back and the store re-reads it. */
  const commit = (next: Look[]): boolean => {
    if (!writeLooks(next)) {
      setError(LOOKS_QUOTA_MESSAGE);
      return false;
    }
    setError(false);
    return true;
  };

  const save = () => {
    const next = upsertLook(looks, captureLook(naming ?? ""));
    if (!next) {
      setError(LOOKS_FULL_MESSAGE);
      return;
    }
    if (commit(next)) setNaming(undefined);
  };

  const wear = (look: Look) => {
    // applyLook returns a line only when part of it could not be worn — a
    // scene or image that would not fit. The rest is on either way.
    setError(applyLook(look, { saveCustom, setActive }, setAppearance) ?? false);
  };

  const importFile = (raw: string) => {
    const look = parseLookFile(raw, newLookId());
    if (!look) {
      setError("That file is not a Telar look.");
      return;
    }
    const next = upsertLook(looks, look);
    if (!next) {
      setError(LOOKS_FULL_MESSAGE);
      return;
    }
    if (commit(next)) wear(look);
  };

  return (
    <SettingsGroup
      title="Looks"
      description="The whole appearance as one thing — theme, backdrop, accent, type and translucency, saved together and shareable as a file."
    >
      <Row
        label="Saved looks"
        hint={
          error
            ? error
            : "Click a look to wear it. The desktop translucency switch is never part of one — that is a property of the machine, not of the look."
        }
        control={
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()}>
              <UploadIcon /> Import
            </Button>
            <Button size="sm" variant="outline" onClick={() => setNaming((current) => (current === undefined ? "" : undefined))}>
              Save current look…
            </Button>
          </div>
        }
      >
        {naming !== undefined && (
          <div className="mt-2 flex items-center gap-1.5">
            <Input
              autoFocus
              className="max-w-64"
              value={naming}
              placeholder="e.g. Deep sea night"
              aria-label="Look name"
              onChange={(event) => setNaming(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") save();
                if (event.key === "Escape") setNaming(undefined);
              }}
            />
            <Button size="sm" onClick={save}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setNaming(undefined)}>
              Cancel
            </Button>
          </div>
        )}
      </Row>
      <div className="px-4 py-3">
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          aria-hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Cleared so picking the SAME file twice still fires a change.
            event.target.value = "";
            if (!file) return;
            void file.text().then(importFile);
          }}
        />
        {looks.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nothing saved yet. Get the app looking how you want it, then save that as a look you can come back to — or send to another machine.
          </p>
        ) : (
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {looks.map((look) => (
              <LookCard
                key={look.id}
                look={look}
                // Worn = the library is wearing the theme this Look installs.
                // The backdrop and type can be edited afterwards, so this is
                // deliberately "you started from here", not "nothing changed".
                active={activeId === lookThemeId(look)}
                onWear={() => wear(look)}
                onExport={() => downloadFile(lookFilename(look), serializeLook(look))}
                onRemove={() => commit(looks.filter((entry) => entry.id !== look.id))}
              />
            ))}
          </div>
        )}
      </div>
    </SettingsGroup>
  );
}

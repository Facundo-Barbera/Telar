"use client";

/**
 * LOOKS — the shelf of whole appearances, and where a design session starts.
 *
 * A card here is the theme AND the backdrop AND the accent AND the type AND
 * the translucency strength, captured together (lib/looks.ts states what is in
 * the bundle and why the desktop translucency TOGGLE is not).
 *
 * OPENING A LOOK IS A DRAFT EDIT, like everything else on the pane now:
 * clicking a card loads the whole Look into the studio draft, which the
 * preview paints on the app instantly — it LOOKS worn, but nothing persists
 * until Apply. The id rides along, so Save updates this card rather than
 * copying it. Import goes the same way: the file becomes a card and opens as
 * the draft, previewed rather than auto-worn.
 *
 * Saving lives in the pane header ("Save look") — one save path, fed by the
 * draft, instead of the old second button here that captured the live stores
 * behind the draft's back.
 */

import { useRef, useState } from "react";
import { CheckIcon, DownloadIcon, Trash2Icon, UploadIcon } from "lucide-react";
import {
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
import { useThemeLibrary } from "@/lib/theme-palettes";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
 * The strip: the Look's two CANVAS colours, light beside dark. Two flat chips
 * read as "one thing with a day and a night", which is what a Look is.
 */
function LookStrip({ look }: { look: Look }) {
  return (
    <div className="flex size-9 shrink-0 overflow-hidden rounded-lg ring-1 ring-foreground/15">
      <span className="flex-1" style={{ background: look.theme.light.background }} />
      <span className="flex-1" style={{ background: look.theme.dark.background }} />
    </div>
  );
}

function LookCard({ look, active, onOpen, onExport, onRemove }: { look: Look; active: boolean; onOpen: () => void; onExport: () => void; onRemove: () => void }) {
  return (
    <div
      className={cn(
        // A STRIP, NOT A GRID: the shelf sits across the top of the editor,
        // where it is a place to start from rather than a section to read. A
        // fixed width keeps the cards a scannable rank instead of a ragged one.
        "group flex w-60 shrink-0 cursor-pointer items-center gap-3 rounded-xl bg-card p-3 ring-1 ring-foreground/10 transition-colors hover:bg-accent/50",
        active && "ring-2 ring-primary",
      )}
      onClick={onOpen}
      role="button"
      title={`Open ${look.label} in the studio`}
      aria-label={`Open ${look.label} in the studio`}
      aria-pressed={active}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <LookStrip look={look} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <span className="truncate">{look.label}</span>
          {active && <CheckIcon className="size-3.5 shrink-0 text-primary" />}
        </div>
        <div className="text-[11px] text-muted-foreground">{BACKDROP_LABEL[look.backdrop.kind]}</div>
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

export function LooksSection({ onOpen }: { onOpen: (look: Look) => void }) {
  const { activeId } = useThemeLibrary();
  const looks = useLooks();
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
    // Shelved, then opened as the draft — previewed on the app, worn on Apply.
    if (commit(next)) onOpen(look);
  };

  return (
    <SettingsGroup
      title="Looks"
      description="The whole appearance as one thing — theme, backdrop, accent, type and strength, saved together and shareable as a file."
    >
      <Row
        label="Saved looks"
        hint={
          error
            ? error
            : "Click a look to open it in the studio — the app previews it instantly, and Apply wears it. Save look, above, updates the card a draft came from."
        }
        control={
          <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()}>
            <UploadIcon /> Import
          </Button>
        }
      />
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
            Nothing saved yet. Get the draft looking how you want it, then press Save look — the card lands here, and travels as a file.
          </p>
        ) : (
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {looks.map((look) => (
              <LookCard
                key={look.id}
                look={look}
                // Worn = the library is wearing the theme this Look installs.
                active={activeId === lookThemeId(look)}
                onOpen={() => onOpen(look)}
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

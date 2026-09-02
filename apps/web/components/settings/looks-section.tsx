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
 *
 * THE SHELF IS NEVER EMPTY. Six STARTERS (lib/starter-looks.ts) stand after
 * whatever has been saved — built from the same themes and presets the pane
 * offers, so they cost no storage and cannot be deleted away. They are what
 * makes this pane legible on first arrival: the first thing you can do here is
 * wear something, not read a paragraph about what a Look would be.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CheckIcon, DownloadIcon, LayersIcon, MonitorSmartphoneIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { createEngineApi } from "@/lib/engine/client";
import { isHostWindow } from "@/lib/host-window";
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
import { STARTER_LOOKS } from "@/lib/starter-looks";
import { useThemeLibrary } from "@/lib/theme-palettes";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Panel, PanelBody, PanelHeader, PanelRow } from "@/components/ui/panel";
import { LookThumb } from "./look-thumb";

/** The one word the HOST row still needs — a row has no thumbnail to say it
 *  with. The cards do, so they carry no subtitle at all. */
const BACKDROP_LABEL: Record<Look["backdrop"]["kind"], string> = {
  none: "no backdrop",
  gradient: "gradient",
  "custom-gradient": "custom gradient",
  image: "image",
  scene: "composed scene",
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

/** The host row's avatar — the same thumbnail the cards use, at row size. */
function LookStrip({ look }: { look: Look }) {
  return (
    <div className="w-14 shrink-0">
      <LookThumb look={look} />
    </div>
  );
}

/**
 * A CARD IS THE LOOK ITSELF — a thumbnail, and a name under it. The old card
 * spent two thirds of its width on words ("Gradient", "Composed scene") that
 * the picture says better, and the picture is the only thing anyone chooses a
 * look by.
 */
function LookCard({
  look,
  active,
  onOpen,
  onExport,
  onRemove,
}: {
  look: Look;
  active: boolean;
  onOpen: () => void;
  onExport?: () => void;
  onRemove?: () => void;
}) {
  return (
    <div
      className={cn(
        // A RANK, NOT A GRID: the shelf runs across the top of the editor,
        // where it is a place to start from rather than a section to read.
        "group relative w-32 shrink-0 cursor-pointer rounded-lg p-1 ring-1 transition-colors",
        active ? "ring-2 ring-primary" : "ring-foreground/10 hover:bg-accent/50",
      )}
      onClick={onOpen}
      role="button"
      title={`Open ${look.label}`}
      aria-label={`Open ${look.label}`}
      aria-pressed={active}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <LookThumb look={look} />
      <div className="flex items-center gap-1 px-0.5 pt-1.5 pb-0.5 text-xs">
        <span className="min-w-0 flex-1 truncate font-medium">{look.label}</span>
        {active && <CheckIcon className="size-3 shrink-0 text-primary" />}
      </div>
      {(onExport || onRemove) && (
        <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {onExport && (
            <Button
              size="icon-sm"
              variant="secondary"
              className="size-6 shadow-sm"
              title="Export"
              aria-label={`Export ${look.label}`}
              onClick={(event) => (event.stopPropagation(), onExport())}
            >
              <DownloadIcon />
            </Button>
          )}
          {onRemove && (
            <Button
              size="icon-sm"
              variant="secondary"
              className="size-6 shadow-sm"
              title="Delete"
              aria-label={`Delete ${look.label}`}
              onClick={(event) => (event.stopPropagation(), onRemove())}
            >
              <Trash2Icon />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * THE HOST'S LOOK — the first thing that ever READ what the cockpit publishes.
 *
 * A window reached over tailscale is the same app with its own localStorage, so
 * it starts with an empty shelf and the default palette while the machine it is
 * driving wears something deliberate. The engine has known what the host looks
 * like for a while and nothing had ever asked. This row asks.
 *
 * IT LOADS INTO THE DRAFT, LIKE EVERY OTHER SOURCE. The published blob parses
 * into a `Look` — the same type a shelf card holds — so opening it goes through
 * the same `onOpen` an import or a card does: previewed on the real app,
 * undoable, worn only on Apply. There is deliberately no "wear it now" path;
 * somebody else's taste is a starting point, not a command.
 *
 * ONLY WHERE IT IS NOT A REFLECTION. The host publishes; showing the host its
 * own published look would be a card of what it is already wearing. The gate is
 * lib/host-window.ts, the same one the publisher uses, so the two can never
 * disagree about which window is which.
 *
 * EVERY OUTCOME IS A HINT LINE, this file's idiom for "three different things
 * to do about it": nothing published yet, an engine that would not answer, and
 * a blob that did not parse are three different sentences.
 */
const api = createEngineApi();

type HostLookState = { status: "loading" } | { status: "ready"; look: Look } | { status: "empty" | "failed" | "invalid" };

const HOST_LOOK_HINT: Record<"loading" | "empty" | "failed" | "invalid", string> = {
  loading: "Asking the engine…",
  empty: "Nothing published yet — the host publishes on its own.",
  failed: "The engine did not answer.",
  invalid: "The host published something this build cannot read.",
};

function HostLookRow({ onOpen }: { onOpen: (look: Look) => void }) {
  const [state, setState] = useState<HostLookState>({ status: "loading" });
  /** Retry is a NEW ASK, not a re-render of the old one — bumping this is what
   *  re-runs the effect, so the fetch stays in the effect where its cleanup
   *  can disown a late answer. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    void api
      .appearance()
      .then((answer) => {
        if (!live) return;
        // The adapter already ran the shared parser, so a non-null answer is a
        // Look this build can wear. Null covers both "nobody published" and
        // "what they published did not parse" — and those want different
        // sentences, so the absence of a timestamp tells them apart.
        if (answer.appearance) setState({ status: "ready", look: answer.appearance.look });
        else setState({ status: answer.updatedAt === null ? "empty" : "invalid" });
      })
      .catch(() => {
        if (live) setState({ status: "failed" });
      });
    return () => {
      live = false;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((count) => count + 1);
  }, []);

  return (
    <PanelRow tone="info" className="border-b border-border">
      {state.status === "ready" ? (
        <LookStrip look={state.look} />
      ) : (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground [&_svg]:size-4">
          <MonitorSmartphoneIcon />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="font-medium">Host&apos;s look</div>
        <div className="truncate text-xs text-muted-foreground">
          {state.status === "ready" ? `“${state.look.label}” — ${BACKDROP_LABEL[state.look.backdrop.kind]}` : HOST_LOOK_HINT[state.status]}
        </div>
      </div>
      {state.status === "ready" ? (
        <Button size="sm" variant="outline" onClick={() => onOpen(state.look)}>
          Open
        </Button>
      ) : (
        <Button size="sm" variant="ghost" disabled={state.status === "loading"} onClick={retry}>
          {state.status === "loading" ? "Loading…" : "Retry"}
        </Button>
      )}
    </PanelRow>
  );
}

// Whether this window is the host is an external fact, settled before React ran
// and never changing — the same idiom appearance-section.tsx uses for the
// desktop bridge.
const subscribeToNothing = () => () => {};
const hostNow = () => isHostWindow();
const hostOnTheServer = () => true;

export function LooksSection({ onOpen }: { onOpen: (look: Look) => void }) {
  // Defaults to "this IS the host" on the server, so the row never renders into
  // the first paint and then vanishes on hydration.
  const isHost = useSyncExternalStore(subscribeToNothing, hostNow, hostOnTheServer);
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
    <Panel>
      <PanelHeader
        icon={<LayersIcon />}
        label="Looks"
        count={looks.length + STARTER_LOOKS.length}
        actions={
          <Button size="icon-sm" variant="ghost" title="Import a look file" aria-label="Import a look" onClick={() => fileInput.current?.click()}>
            <UploadIcon />
          </Button>
        }
      />
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
      {error && <p className="border-b border-border px-3 py-1.5 text-xs text-warning">{error}</p>}
      {!isHost && <HostLookRow onOpen={onOpen} />}
      <PanelBody className="overflow-x-auto p-2">
        <div className="flex items-start gap-1.5">
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
          {looks.length > 0 && <span className="mx-1 h-16 w-px shrink-0 self-center bg-border" />}
          {STARTER_LOOKS.map((look) => (
            <LookCard
              key={look.id}
              look={look}
              active={activeId === lookThemeId(look)}
              // A NEW ID: a starter is somewhere to begin, so Save shelves a
              // card of your own rather than trying to update one that only
              // ever existed in this build's table.
              onOpen={() => onOpen({ ...look, id: newLookId() })}
            />
          ))}
        </div>
      </PanelBody>
    </Panel>
  );
}

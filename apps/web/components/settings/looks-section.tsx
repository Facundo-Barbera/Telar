"use client";

/**
 * LOOKS — the shelf of whole appearances, and where a design session starts.
 *
 * A card here is the theme AND the backdrop AND the accent AND the type AND
 * the translucency strength, captured together (lib/looks.ts states what is in
 * the bundle and why the desktop translucency TOGGLE is not).
 *
 * TWO GESTURES, TWO MEANINGS. Clicking a card SELECTS it — loaded into the
 * editor, previewed on the real app, nothing persisted. Hovering reveals WEAR,
 * which puts it on outright. The shelf used to offer only the first, so the
 * cheapest thing anyone wants to do here — "just put that one on" — cost a
 * click, a scan for the Apply button, and a second click. Wear keeps the pane's
 * one rule intact: it is Apply, reached from the card instead of the masthead.
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
import { useFollowHost } from "@/lib/host-follow";
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
import { matchThemeHalf, useThemeLibrary } from "@/lib/theme-palettes";
import { useAppearance } from "@/lib/appearance";
import { useBackdrop, type Backdrop } from "@/lib/backdrop";

/** Same scene, by the CHOICE rather than by the resolved pixels — two gradients
 *  from one preset are the same scene even if one carries a dim the other does
 *  not, and comparing megabytes of image data to draw a tick would be absurd. */
function sameScene(look: Look["backdrop"], worn: Backdrop): boolean {
  if (look.kind !== worn.kind) return false;
  if (look.kind === "gradient" && worn.kind === "gradient") return look.id === worn.id;
  return true;
}
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { Switch } from "@/components/ui/switch";
import { LookThumb } from "./look-thumb";
import { Row } from "./settings-shell";

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
  selected,
  onOpen,
  onWear,
  onExport,
  onRemove,
}: {
  look: Look;
  /** Worn: the library is wearing the theme this Look installs. */
  active: boolean;
  /** Open in the editor: the draft in front of you came from this card. */
  selected?: boolean;
  onOpen: () => void;
  /** Put it on now — Apply, without the trip to the masthead. */
  onWear: () => void;
  onExport?: () => void;
  onRemove?: () => void;
}) {
  return (
    <div
      className={cn(
        // A RANK, NOT A GRID: the shelf runs across the top of the editor,
        // where it is a place to start from rather than a section to read.
        // SELECTED AND WORN ARE DIFFERENT FACTS. Clicking a card loads it into
        // the editor and previews it; wearing it is Apply. The shelf drew only
        // one of those, so "the look I am working on" and "the look this window
        // has on" were the same pixel — and after a click they disagree.
        "group relative w-32 shrink-0 cursor-pointer rounded-lg p-1 ring-1 transition-colors",
        selected ? "ring-2 ring-primary" : active ? "ring-2 ring-muted-foreground/40" : "ring-foreground/10 hover:bg-accent/50",
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
      {/* WEAR sits ON the thumbnail, centred, revealed on hover: the card's
          primary verb, where the eye already is. Export and delete stay in the
          corner — they are about the file, not about wearing it. */}
      {!active && (
        <div className="pointer-events-none absolute inset-x-1 top-1 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" style={{ height: "calc(100% - 2.25rem)" }}>
          <Button
            size="sm"
            variant="secondary"
            className="pointer-events-auto h-7 shadow-1"
            title={`Wear ${look.label} now`}
            onClick={(event) => (event.stopPropagation(), onWear())}
          >
            Wear
          </Button>
        </div>
      )}
      <div className="flex items-center gap-1 px-0.5 pt-1.5 pb-0.5 text-xs">
        <span className="min-w-0 flex-1 truncate font-medium">{look.label}</span>
        {active && (
          <span className="shrink-0 text-muted-foreground [&_svg]:size-3" title="Worn">
            <CheckIcon />
          </span>
        )}
        {selected && <span className="shrink-0 font-mono text-[0.5625rem] tracking-[0.08em] text-primary uppercase">Open</span>}
      </div>
      {(onExport || onRemove) && (
        <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {onExport && (
            <Button
              size="icon-sm"
              variant="secondary"
              className="size-6 shadow-1"
              title="Export"
              aria-label={`Export ${look.label}`}
              onClick={(event) => (event.stopPropagation(), onExport())}
            >
              <DownloadIcon />
            </Button>
          )}
          {onRemove && (
            // WHAT DELETING DOES NOT DESTROY. A look is a bundle of references —
            // removing the card takes the bundle off the shelf and leaves the
            // theme it names in the library, and the window keeps whatever it
            // has on. Said here, where the hand is, rather than nowhere.
            <Button
              size="icon-sm"
              variant="secondary"
              className="size-6 shadow-1"
              title="Take this look off the shelf. Its theme stays in the library, and the window keeps what it has on."
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
 * THE HOST'S LOOK — what a remote window wears, and the switch that decides.
 *
 * A window reached over tailscale is the same app with its own localStorage, so
 * it used to start with an empty shelf and the default palette while the
 * machine it was driving wore something deliberate. It now FOLLOWS the host
 * (components/host-look-follower.tsx) until its person customises anything on
 * this pane, at which point it detaches and keeps its own taste. This row is
 * where that state is visible and reversible: the switch is the follow mode
 * (lib/host-follow.ts), and re-enabling it wears the host's current look at
 * once.
 *
 * DETACHED, THE ROW IS STILL A SOURCE. The published blob parses into a `Look`
 * — the same type a shelf card holds — so "Open" loads it into the draft like
 * an import or a card does: previewed on the real app, undoable, worn only on
 * Apply. Following, the look is already on; Open would preview what is worn.
 *
 * ONLY WHERE IT IS NOT A REFLECTION. The host publishes; showing the host its
 * own published look would be a card of what it is already wearing, and a
 * host that "followed" itself would be a two-second loop. The gate is
 * lib/host-window.ts, the same one the publisher and the follower use, so the
 * three can never disagree about which window is which.
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
  const { mode, detach, follow } = useFollowHost();
  const following = mode === "follow";
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

  const ready = state.status === "ready";
  return (
    // ON THE SETTINGS GRAMMAR, INSIDE A PANEL. This row had hand-rolled `Row`'s
    // whole anatomy — a `font-medium` div for the label, a muted `text-xs` one
    // for the hint, controls pushed right — which is exactly the duplication
    // the shared grammar exists to end. `Row` eats no padding of its own, so a
    // Panel supplies the horizontal inset the way a SettingsGroup would
    // (settings-shell.tsx says so); the hairline stays, the `tone="info"` rail
    // goes, because a rail on the one row a panel has says nothing the row does
    // not already say.
    <div className="border-b border-border px-3">
      <Row
        // The label carries the thumbnail, so it is not a string and cannot
        // derive its own anchor.
        id="settings-row-appearance-host-look"
        label={
          <span className="flex items-center gap-2">
            {ready ? (
              <LookStrip look={state.look} />
            ) : (
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground [&_svg]:size-4">
                <MonitorSmartphoneIcon />
              </span>
            )}
            <span>{following ? "Following the host's look" : "Host's look"}</span>
          </span>
        }
        hint={
          ready
            ? `“${state.look.label}” — ${BACKDROP_LABEL[state.look.backdrop.kind]}${following ? " · changing anything here stops following" : ""}`
            : HOST_LOOK_HINT[state.status]
        }
        control={
          <div className="flex items-center gap-2">
            {ready && !following && (
              <Button size="sm" variant="outline" onClick={() => onOpen(state.look)}>
                Open
              </Button>
            )}
            {!ready && (
              <Button size="sm" variant="ghost" disabled={state.status === "loading"} onClick={retry}>
                {state.status === "loading" ? "Loading…" : "Retry"}
              </Button>
            )}
            {/* NOT `unavailable`, deliberately. There is nothing to follow until
                the host publishes something — but Retry is the whole point of
                the not-ready states, and `unavailable` would take the control
                column inert as a unit and disable the one control that still
                works. The switch says no for itself. */}
            <Switch
              checked={following}
              disabled={!ready && !following}
              onCheckedChange={(next) => (next ? follow() : detach())}
              aria-label="Follow the host's look"
              title={
                ready
                  ? following
                    ? "Stop following the host's look"
                    : "Wear the host's look, and keep wearing it as it changes"
                  : "The host has not published a look to follow."
              }
            />
          </div>
        }
      />
    </div>
  );
}

// Whether this window is the host is an external fact, settled before React ran
// and never changing — the same idiom appearance-section.tsx uses for the
// desktop bridge.
const subscribeToNothing = () => () => {};
const hostNow = () => isHostWindow();
const hostOnTheServer = () => true;

export function LooksSection({ onOpen, onWear, openId }: { onOpen: (look: Look) => void; onWear: (look: Look) => void; openId?: string }) {
  // Defaults to "this IS the host" on the server, so the row never renders into
  // the first paint and then vanishes on hydration.
  const isHost = useSyncExternalStore(subscribeToNothing, hostNow, hostOnTheServer);
  const { activeId, active, themes } = useThemeLibrary();
  const { appearance } = useAppearance();
  const { backdrop } = useBackdrop();
  /**
   * WORN IS ABOUT WHAT THE WINDOW HAS ON, NOT ABOUT AN ID. Wearing a look whose
   * palette is already in the library now wears THAT theme rather than minting
   * a copy (applyLook), so the id this card would have installed may never
   * exist and an id test would mark nothing at all.
   *
   * BUT A PALETTE IS NOT A LOOK. Dusk and Deep Sea are both built on Tide, so a
   * colours-only test marked both of them worn at once — two cards claiming the
   * one thing only one of them can be true of. A look is its palette AND its
   * scene AND its accent, so all three have to agree.
   */
  const worn = useCallback(
    (look: Look) => {
      if (look.accent !== appearance.accent) return false;
      if (!sameScene(look.backdrop, backdrop)) return false;
      if (activeId === lookThemeId(look)) return true;
      const lightTheme = themes.find((theme) => theme.id === active.light);
      const darkTheme = themes.find((theme) => theme.id === active.dark);
      if (!lightTheme || !darkTheme) return false;
      return (
        matchThemeHalf(look.theme.light, [lightTheme], "light") !== undefined &&
        matchThemeHalf(look.theme.dark, [darkTheme], "dark") !== undefined
      );
    },
    [activeId, active, themes, appearance.accent, backdrop],
  );
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
              active={worn(look)}
              selected={openId === look.id}
              onOpen={() => onOpen(look)}
              onWear={() => onWear(look)}
              onExport={() => downloadFile(lookFilename(look), serializeLook(look))}
              onRemove={() => commit(looks.filter((entry) => entry.id !== look.id))}
            />
          ))}
          {looks.length > 0 && <span className="mx-1 h-16 w-px shrink-0 self-center bg-border" />}
          {STARTER_LOOKS.map((look) => (
            <LookCard
              key={look.id}
              look={look}
              active={worn(look)}
              selected={openId === look.id}
              onWear={() => onWear(look)}
              // The starter's OWN id rides into the draft. It is stable, so
              // opening Dusk twice and applying both updates one theme instead
              // of breeding a second one called Dusk. The fresh id is minted at
              // SAVE (appearance-section), which is the moment it stops being a
              // starter and becomes a card of your own.
              onOpen={() => onOpen(look)}
            />
          ))}
        </div>
      </PanelBody>
    </Panel>
  );
}

"use client";

/**
 * LOOKS — the gallery of whole appearances, and the ONLY preset system (#471).
 *
 * A row here is a COMPOSITION — both colour states, their bases, their layers
 * and anything set by hand — plus the accent, the two faces, their sizes, the
 * show-through and the depth, captured together (lib/looks.ts states what is in
 * the bundle and why the desktop translucency TOGGLE is not).
 *
 * THERE IS NOTHING UNDERNEATH IT ANY MORE. This used to sit above a LIBRARY of
 * themes answering an overlapping question — a look referenced a palette, a
 * palette could also be picked on its own, and a reader had to hold two ideas
 * apart to change one colour. "Themes should not exist, there should be default
 * settings for the composer." The defaults are the ten built-ins at the bottom
 * of this list (lib/built-in-looks.ts), and the composer below is what a look
 * is made of.
 *
 * A TABLE, NOT A STACK OF CARDS (#471). It was a strip of thumbnails, then a
 * stack of full-height `Row`s — and the owner ran the build: "the looks UI is
 * too long; when you land on the looks you have to scroll a lot. We should use
 * tables for this like we do in other interfaces." Ten built-ins as rows with a
 * 56px thumbnail and a control column was most of a screen before a reader got
 * to the composer that the whole pane is actually about. A person looking at a
 * list of looks is COMPARING them, which is what columns are for — the same
 * reasoning remote-section.tsx's device table already lives under.
 *
 * SO THE ROW IS THREE CELLS: what it looks like and what it is called, what it
 * carries in one phrase, and what you can do to it. Ten rows fit in about 320px,
 * which is the number the ask was actually about.
 *
 * ONE GESTURE, ONE MEANING. The NAME wears the look — it is the row's primary
 * action and the only one that is always visible, because wearing is the thing
 * you came here to do. The other three (rename, export, delete) sit in a
 * trailing cell that appears on hover or focus: they act on a card you already
 * own, so they can wait to be reached for, and `group-focus-within` is what
 * keeps them reachable by keyboard rather than by pointer alone.
 *
 * Import goes the same way as wearing: the file becomes a card and is worn.
 *
 * SAVE LIVES HERE, on the group that holds the list. It photographs both
 * appearance stores as they stand (`captureLook`) — which is the whole of what
 * saving means once nothing is pending — and the new card appears right here.
 *
 * THE DEFAULTS ARE NEVER EMPTY AND NEVER DELETABLE, being a table rather than
 * storage. They are what makes this pane legible on first arrival: the first
 * thing you can do here is wear something, not read a paragraph about what a
 * Look would be.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DownloadIcon, MonitorSmartphoneIcon, PencilIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { createEngineApi } from "@/lib/engine/client";
import { useFollowHost } from "@/lib/host-follow";
import { isHostWindow } from "@/lib/host-window";
import {
  captureLook,
  lookFilename,
  newLookId,
  parseLookFile,
  sameComposition,
  serializeLook,
  upsertLook,
  useLooks,
  writeLooks,
  LOOKS_FULL_MESSAGE,
  LOOKS_QUOTA_MESSAGE,
  type Look,
} from "@/lib/looks";
import { BUILT_IN_LOOKS, BUILT_IN_NOTES } from "@/lib/built-in-looks";
import { useAppearance } from "@/lib/appearance";
import { useComposition } from "@/lib/composition";
import { MONO_LABEL, SANS_LABEL } from "./studio/tools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { LookThumb } from "./look-thumb";
import { Row, SettingsGroup } from "./settings-shell";

/**
 * WHAT A LOOK'S COMPOSITION IS, IN A PHRASE.
 *
 * A thumbnail shows the scene but cannot say how it is MADE — a photograph and
 * a gradient can look alike at 56px, and only one of them will still be there
 * when the gradient presets change. The two states are counted separately
 * because they genuinely can differ; when they agree, which is the common case,
 * the phrase says it once.
 */
function stackPhrase(layers: readonly { type: string }[]): string {
  if (layers.length === 0) return "flat";
  const images = layers.filter((layer) => layer.type === "image").length;
  const gradients = layers.length - images;
  const parts: string[] = [];
  if (gradients > 0) parts.push(`${gradients} gradient${gradients === 1 ? "" : "s"}`);
  if (images > 0) parts.push(`${images} image${images === 1 ? "" : "s"}`);
  return parts.join(" + ");
}

function compositionPhrase(look: Look): string {
  const light = stackPhrase(look.composition.light.layers);
  const dark = stackPhrase(look.composition.dark.layers);
  return light === dark ? light : `${light} / ${dark}`;
}

/** WHAT A LOOK CARRIES, IN ONE LINE: what it is made of, and its two faces.
 *  A built-in says what it is in its own words instead — the table wrote them,
 *  and "Tide, under a dusk gradient" is a better sentence than anything a
 *  layer count can assemble. */
function lookSummary(look: Look): string {
  const sans = look.fontSans === "custom" ? look.fontSansCustom || "a custom face" : SANS_LABEL[look.fontSans];
  const mono = look.fontMono === "custom" ? look.fontMonoCustom || "a custom face" : MONO_LABEL[look.fontMono];
  const what = BUILT_IN_NOTES[look.id] ?? compositionPhrase(look);
  return `${what} · ${look.accent} · ${sans} / ${mono}`;
}

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
 * ONE LOOK, AS A TABLE ROW.
 *
 * The thumbnail is small on purpose — 40px wide, an aspect-video sliver — which
 * is what lets ten of these fit a short window. It is still the real compiled
 * tile (look-thumb.tsx), not a swatch: at that size it says "dark, with a
 * gradient" and that is the whole job.
 *
 * THE NAME IS THE WEAR BUTTON. It reads as a name and behaves as the row's
 * action, which is the one thing every reader wants from this list. When the
 * look is already on it is inert and the Worn mark says why.
 *
 * RENAMING IS INLINE, and it is the only editing a Look supports: everything
 * else about a look is changed by wearing it and moving the controls below,
 * then saving again. The field commits on Enter or blur and abandons on Escape,
 * the same contract `HexField` has in the palette rows — an empty name is a
 * refusal rather than a card with no name.
 */
function LookRow({
  look,
  summary,
  worn,
  lastSaved,
  onWear,
  onRename,
  onExport,
  onRemove,
}: {
  look: Look;
  /** What the bundle carries, in one line — built by the caller, which is where
   *  the defaults' own notes live. */
  summary: string;
  /** The window has this look on. */
  worn: boolean;
  /** The last card you saved, with the built-ins beginning underneath — the one
   *  row that draws a stronger hairline. See the `<tr>`. */
  lastSaved?: boolean;
  onWear: () => void;
  /** Absent for a default: it is a table this build rebuilds every load, not a
   *  card, so there is nothing of yours to rename. */
  onRename?: (label: string) => void;
  onExport?: () => void;
  onRemove?: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(look.label);

  const commitRename = () => {
    setRenaming(false);
    const trimmed = draftName.trim();
    if (trimmed.length > 0 && trimmed !== look.label) onRename?.(trimmed);
  };

  return (
    /**
     * ONE WEIGHT FOR "NEXT ROW", ANOTHER FOR "DIFFERENT KIND OF ROW".
     *
     * Every row drawing the same hairline is what made this card read as a
     * wireframe in the dark half: the group already carries `border border-border`
     * and `divide-y divide-border/60` around it, the header draws one more, and
     * ten rows at the same weight say nothing about where the shelf ends. At /40
     * a divider still separates two rows and stops competing with the card edge.
     *
     * The boundary that MEANS something gets the stronger line, and it is drawn
     * as a `border-b` on the last saved card rather than a `border-t` on the
     * first built-in: under `border-collapse` two rows' adjacent borders resolve
     * to one, and at equal width and style the higher row wins — a `border-t`
     * below would have been swallowed by the /40 above it.
     */
    <tr className={cn("group border-b align-middle last:border-0", lastSaved ? "border-border/70" : "border-border/40")}>
      <td className="py-1.5 pr-3 pl-4">
        <span className="flex items-center gap-2.5">
          <span className="w-10 shrink-0">
            <LookThumb look={look} />
          </span>
          {renaming ? (
            <Input
              autoFocus
              value={draftName}
              aria-label={`Rename ${look.label}`}
              // `flex-1 min-w-0`, not the `w-40` it carried: 160px is wider
              // than the name has in a fixed Look column, and a field that
              // overflows its cell is the same defect the table just fixed.
              className="h-6 min-w-0 flex-1 px-1.5 text-xs"
              onChange={(event) => setDraftName(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitRename();
                }
                if (event.key === "Escape") {
                  setRenaming(false);
                  setDraftName(look.label);
                }
              }}
            />
          ) : (
            <button
              type="button"
              disabled={worn}
              // No title when worn: the mark beside it already says so, and two
              // elements claiming "the window has this on" is two claims.
              {...(worn ? {} : { title: `Wear ${look.label}` })}
              onClick={onWear}
              className="min-w-0 truncate text-left font-medium decoration-dotted underline-offset-2 hover:underline disabled:cursor-default disabled:no-underline"
            >
              {look.label}
            </button>
          )}
          {worn && (
            <span className="shrink-0 font-mono text-4xs tracking-[0.08em] text-primary uppercase" title="The window has this look on">
              Worn
            </span>
          )}
        </span>
      </td>
      <td className="py-1.5 pr-3 text-muted-foreground">
        <span className="block truncate">{summary}</span>
      </td>
      <td className="py-1.5 pr-4">
        {/* HOVER OR FOCUS, and focus is the half that matters: the buttons stay
            in the tab order at opacity 0, so reaching one reveals the set. */}
        <div className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <Button size="sm" variant="ghost" disabled={worn} title={`Wear ${look.label}`} onClick={onWear}>
            Wear
          </Button>
          {onRename && (
            <Button
              size="icon-sm"
              variant="ghost"
              title="Rename"
              aria-label={`Rename ${look.label}`}
              onClick={() => {
                setDraftName(look.label);
                setRenaming(true);
              }}
            >
              <PencilIcon />
            </Button>
          )}
          {onExport && (
            <Button size="icon-sm" variant="ghost" title="Export" aria-label={`Export ${look.label}`} onClick={onExport}>
              <DownloadIcon />
            </Button>
          )}
          {onRemove && (
            // WHAT DELETING DOES NOT DESTROY. Removing the card takes the
            // composition off the shelf; the window keeps whatever it has on,
            // and the built-ins below are a table this build rebuilds every
            // load. Said here, where the hand is, rather than nowhere.
            <Button
              size="icon-sm"
              variant="ghost"
              title="Take this look off the shelf. The window keeps what it has on."
              aria-label={`Delete ${look.label}`}
              onClick={onRemove}
            >
              <Trash2Icon />
            </Button>
          )}
        </div>
      </td>
    </tr>
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
 * — the same type a shelf card holds — so "Wear" puts the host's look on like
 * any card does, without resuming the follow. Following, the look is already
 * on, so the button would do nothing and is not drawn.
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

function HostLookRow({ onWear }: { onWear: (look: Look) => void }) {
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
  // ON THE SETTINGS GRAMMAR. This row had hand-rolled `Row`'s whole anatomy — a
  // `font-medium` div for the label, a muted `text-xs` one for the hint,
  // controls pushed right — which is exactly the duplication the shared grammar
  // exists to end. `Row` eats no padding of its own and draws no hairline: the
  // `SettingsGroup` card around it supplies both to its direct children
  // (settings-shell.tsx says so), which is why the wrapper this used to carry
  // went with the Panel in #399.
  return (
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
          ? `“${state.look.label}” — ${compositionPhrase(state.look)}${following ? " · changing anything here stops following" : ""}`
          : HOST_LOOK_HINT[state.status]
      }
      control={
        <div className="flex items-center gap-2">
          {ready && !following && (
            <Button size="sm" variant="outline" onClick={() => onWear(state.look)}>
              Wear
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
  );
}

// Whether this window is the host is an external fact, settled before React ran
// and never changing — the same idiom appearance-section.tsx uses for the
// desktop bridge.
const subscribeToNothing = () => () => {};
const hostNow = () => isHostWindow();
const hostOnTheServer = () => true;

export function LooksSection({ onWear }: { onWear: (look: Look) => void }) {
  // Defaults to "this IS the host" on the server, so the row never renders into
  // the first paint and then vanishes on hydration.
  const isHost = useSyncExternalStore(subscribeToNothing, hostNow, hostOnTheServer);
  const { appearance } = useAppearance();
  const { composition } = useComposition();
  /**
   * WORN IS ABOUT WHAT THE WINDOW HAS ON, NOT ABOUT AN ID. Wearing a look
   * copies its composition into the live store and installs nothing anywhere,
   * so there is no id to test against — and the built-ins are rebuilt from a
   * table on every load, which an id test would mark worn or not by accident.
   *
   * BUT A COMPOSITION IS NOT A LOOK. Dusk and Deep Sea share a base, and Ember
   * and Emberglow share everything but a layer, so the comparison has to be the
   * whole composition AND the accent — anything looser marks two cards worn at
   * once, which is a claim only one of them can be true of.
   */
  const worn = useCallback(
    (look: Look) => look.accent === appearance.accent && sameComposition(look.composition, composition),
    [appearance.accent, composition],
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
    // Shelved, then worn: importing a look is asking to see it.
    if (commit(next)) onWear(look);
  };

  /** A photograph of both appearance stores, shelved. A fresh id every time —
   *  Save means "keep this one too", never "overwrite the last one". Named
   *  after whatever is worn when one of the defaults is, so saving a tweak to
   *  Dusk gives a card that says where it came from; otherwise it is untitled
   *  and renamed on its row. */
  const saveLook = () => {
    const from = BUILT_IN_LOOKS.find((entry) => worn(entry))?.label;
    const next = upsertLook(looks, captureLook(from ? `${from} — edited` : "My look"));
    if (!next) {
      setError(LOOKS_FULL_MESSAGE);
      return;
    }
    commit(next);
  };

  return (
    // THE SHELF OWNS ITS OWN GROUP, the way InboxSection and
    // BrowserProfilesSection own theirs (#399). It was a `Panel` inside a pane
    // built out of tabs; the pane is stacked `SettingsGroup` cards now, and a
    // section that draws its own card inside one of those is a card in a card.
    // The count and the import button move to the caption line, which is where
    // a control that acts on the WHOLE group belongs.
    <SettingsGroup
      title="Looks"
      description="A look is a whole composition — both colour states, their layers and their colours — with the accent, the type and the depth saved around it. Wear one to put the lot on, then change anything below."
      action={
        <div className="flex items-center gap-2">
          <span className="font-mono text-3xs tracking-[0.08em] text-muted-foreground/60 uppercase tabular-nums">
            {looks.length + BUILT_IN_LOOKS.length}
          </span>
          {/* SAVE IS A PLAIN BUTTON, and it acts on the whole group rather than
              on any row in it — which is exactly what `action` is for. */}
          <Button size="sm" variant="outline" title="Keep what the window is wearing as a card" onClick={saveLook}>
            Save look
          </Button>
          <Button size="icon-sm" variant="ghost" title="Import a look file" aria-label="Import a look" onClick={() => fileInput.current?.click()}>
            <UploadIcon />
          </Button>
        </div>
      }
    >
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
      {error && <p className="py-1.5 text-xs text-warning">{error}</p>}
      {/* THE HOST STAYS A ROW, not a table row. It is not a card on the shelf:
          it is a SOURCE with a follow switch and four different things it can
          say about itself, and squeezing that into three columns headed
          Look/Carries/Actions would be a table lying about what its rows are. */}
      {!isHost && <HostLookRow onWear={onWear} />}
      {/* `-mx-4` because the group pads its direct children and the cells do
          their own padding — the same bleed remote-section.tsx's table uses.
          NO `max-h`: the point of the table is that ten looks fit without
          scrolling, and a scroll box inside a scrolling pane would put that
          back. */}
      <div className="-mx-4">
        {/* `table-fixed` IS WHAT KEEPS THE SHELF INSIDE ITS CARD.
            Under auto layout a cell's content is a VOTE on how wide its column
            should be, and `truncate` never gets to cast one: the span shrinks
            to an ellipsis only once something upstream has capped it, so an
            uncapped `<td>` widened to fit "Tide, under a dusk gradient · violet
            · Geist / Geist Mono" in full and took the table — every row's
            hairline with it — about 110px past the card's right edge.
            Fixed layout reads the widths off THIS row and nothing else, so the
            three below are the whole story and no summary can vote again. */}
        <table className="w-full table-fixed border-collapse text-left text-xs">
          <thead>
            {/* The header's hairline goes with the rows' — it is the same
                wireframe complaint, and a heading row that outweighs the card's
                own edge is the loudest line in the group. */}
            <tr className="border-b border-border/40 text-2xs font-normal tracking-wide text-muted-foreground uppercase">
              {/* The thumbnail, its `pl-4`/`pr-3` and the gap beside it account
                  for most of this; the rest is the name, which truncates like
                  any other cell here. */}
              <th scope="col" className="w-[40%] py-1.5 pr-3 pl-4 font-normal">
                Look
              </th>
              {/* No width: the one unsized column takes whatever the other two
                  leave, which is the column that should absorb a narrow panel. */}
              <th scope="col" className="py-1.5 pr-3 font-normal">
                Carries
              </th>
              {/* The actions column is headed by nothing: its contents are
                  invisible until reached for, and a heading over empty space
                  would be the one thing on the row that never goes away.
                  ITS WIDTH IS ITS BUTTONS, measured rather than guessed: Wear
                  (`sm`, ~50px) + three `icon-sm` at 28px + three 2px gaps +
                  `pr-4` = 156px. Reserved on every row, because a column that
                  fitted only the rows without rename/export/delete would let
                  the hover set overflow leftwards over the summary. */}
              <th scope="col" className="w-[156px] py-1.5 pr-4 font-normal">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {looks.map((look, index) => (
              <LookRow
                key={look.id}
                look={look}
                summary={lookSummary(look)}
                worn={worn(look)}
                lastSaved={index === looks.length - 1}
                onWear={() => onWear(look)}
                onRename={(label) => {
                  const next = upsertLook(looks, { ...look, label });
                  if (next) commit(next);
                }}
                onExport={() => downloadFile(lookFilename(look), serializeLook(look))}
                onRemove={() => commit(looks.filter((entry) => entry.id !== look.id))}
              />
            ))}
            {/* THE DEFAULTS, AFTER WHAT YOU SAVED. They are a table this build
                rebuilds every load, not cards — wearing one copies its
                composition into the live store and installs nothing, and Save is
                what mints a card of your own from whatever is on. Which is also
                why a default has no rename, export or delete: there is nothing
                of yours to act on. */}
            {BUILT_IN_LOOKS.map((look) => (
              <LookRow key={look.id} look={look} summary={lookSummary(look)} worn={worn(look)} onWear={() => onWear(look)} />
            ))}
          </tbody>
        </table>
      </div>
    </SettingsGroup>
  );
}

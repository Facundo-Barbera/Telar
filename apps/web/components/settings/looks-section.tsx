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
 * A LIST, NOT A STRIP. It was an `overflow-x-auto` rank of thumbnails running
 * off the right edge of the pane, which cost three things a settings pane cannot
 * afford: looks past the fourth were INVISIBLE until you thought to scroll
 * sideways inside a vertically-scrolling page; a 128px card had room for a
 * picture and a truncated name and nothing else; and the actions hid behind a
 * hover, which is not a thing a keyboard or a touchscreen has.
 *
 * ONE GESTURE, ONE MEANING. Clicking a row WEARS the look. It used to SELECT one
 * — loaded into a draft, previewed, worn only on Apply — with Wear hidden behind
 * a hover as the shortcut past all that. There is no draft, so there is nothing
 * for a second gesture to mean. Import goes the same way: the file becomes a
 * card and is worn.
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
 * ONE LOOK, AS A ROW.
 *
 * The thumbnail is the avatar (`LookStrip`, the same one the host row wears),
 * the label is the name, the hint is what the bundle carries, and the controls
 * are the four things you can do to a card: wear it, rename it, export it,
 * delete it. Nothing hides behind a hover — the strip's actions did, and a
 * hover is not an affordance a keyboard or a touchscreen has.
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
    // No `id`: the label is a component, so `Row` derives no anchor — and an
    // anchor spliced from a look's own id would be one that moves with data,
    // which is exactly what settings-shell.tsx warns against.
    <Row
      label={
        <span className="flex items-center gap-2.5">
          <LookStrip look={look} />
          {renaming ? (
            <Input
              autoFocus
              value={draftName}
              aria-label={`Rename ${look.label}`}
              className="h-7 w-44"
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
            <span className="min-w-0 truncate">{look.label}</span>
          )}
        </span>
      }
      hint={summary}
      {...(worn
        ? {
            status: (
              <span className="font-mono text-4xs tracking-[0.08em] text-primary uppercase" title="The window has this look on">
                Worn
              </span>
            ),
          }
        : {})}
      control={
        <div className="flex items-center gap-0.5">
          <Button size="sm" variant={worn ? "ghost" : "secondary"} disabled={worn} title={`Wear ${look.label}`} onClick={onWear}>
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
            // WHAT DELETING DOES NOT DESTROY. A look is a bundle of references —
            // removing the card takes the bundle off the shelf and leaves the
            // theme it names in the library, and the window keeps whatever it
            // has on. Said here, where the hand is, rather than nowhere.
            <Button
              size="icon-sm"
              variant="ghost"
              title="Take this look off the shelf. Its theme stays in the library, and the window keeps what it has on."
              aria-label={`Delete ${look.label}`}
              onClick={onRemove}
            >
              <Trash2Icon />
            </Button>
          )}
        </div>
      }
    />
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
      {!isHost && <HostLookRow onWear={onWear} />}
      {looks.map((look) => (
        <LookRow
          key={look.id}
          look={look}
          summary={lookSummary(look)}
          worn={worn(look)}
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
          rebuilds every load, not cards — wearing one copies its composition
          into the live store and installs nothing, and Save is what mints a
          card of your own from whatever is on. Which is also why a default has
          no rename, export or delete: there is nothing of yours to act on. */}
      {BUILT_IN_LOOKS.map((look) => (
        <LookRow key={look.id} look={look} summary={lookSummary(look)} worn={worn(look)} onWear={() => onWear(look)} />
      ))}
    </SettingsGroup>
  );
}

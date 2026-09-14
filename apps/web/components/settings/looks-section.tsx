"use client";

/**
 * LOOKS — the shelf of whole appearances, and where a design session starts.
 *
 * A card here is the theme AND the backdrop AND the accent AND the type AND
 * the translucency strength, captured together (lib/looks.ts states what is in
 * the bundle and why the desktop translucency TOGGLE is not).
 *
 * A LIST, NOT A STRIP (#471). It was an `overflow-x-auto` rank of thumbnails
 * running off the right edge of the pane, which cost three things a settings
 * pane cannot afford: looks past the fourth were INVISIBLE until you thought to
 * scroll sideways inside a vertically-scrolling page; a 128px card had room for
 * a picture and a truncated name and nothing else, so what a look actually
 * CARRIES could only be guessed from a 70px thumbnail; and the actions hid
 * behind a hover, which is not a thing a keyboard or a touchscreen has.
 *
 * So it is `Row`s in the group's card, like every other list in Settings: the
 * thumbnail at the left where the picture still does its work, the name, and a
 * line saying what is in the bundle — which palette (or which pair, when the
 * two halves come from different themes), what is behind the app, and the two
 * faces. The worn one says so with a chip rather than with a ring, and every
 * action is a real button in the control column.
 *
 * ONE GESTURE, ONE MEANING (#471). Clicking a card WEARS the look. It used to
 * SELECT one — loaded into a draft, previewed, worn only on Apply — with Wear
 * hidden behind a hover as the shortcut past all that. There is no draft, so
 * there is nothing for a second gesture to mean: the cheapest thing anyone
 * wants to do here is "put that one on", and it is now the only thing a click
 * does. Import goes the same way: the file becomes a card and is worn.
 *
 * SAVE LIVES HERE, on the group that holds the shelf. It photographs every
 * appearance store as it stands (`captureLook`) and puts the result on the
 * shelf — which is the whole of what saving means once nothing is pending. It
 * was a masthead button fed by the draft; the draft is gone and the shelf is
 * where a new card appears, so the button belongs beside it.
 *
 * THE SHELF IS NEVER EMPTY. Six STARTERS (lib/starter-looks.ts) stand after
 * whatever has been saved — built from the same themes and presets the pane
 * offers, so they cost no storage and cannot be deleted away. They are what
 * makes this pane legible on first arrival: the first thing you can do here is
 * wear something, not read a paragraph about what a Look would be.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DownloadIcon, MonitorSmartphoneIcon, PencilIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { createEngineApi } from "@/lib/engine/client";
import { useFollowHost } from "@/lib/host-follow";
import { isHostWindow } from "@/lib/host-window";
import {
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
import { STARTER_LOOKS } from "@/lib/starter-looks";
import { matchThemeHalf, useThemeLibrary, type ThemeDefinition } from "@/lib/theme-palettes";
import { useAppearance } from "@/lib/appearance";
import { useBackdrop, type Backdrop } from "@/lib/backdrop";
import { MONO_LABEL, SANS_LABEL } from "./studio/tools";

/** Same scene, by the CHOICE rather than by the resolved pixels — two gradients
 *  from one preset are the same scene even if one carries a dim the other does
 *  not, and comparing megabytes of image data to draw a tick would be absurd. */
function sameScene(look: Look["backdrop"], worn: Backdrop): boolean {
  if (look.kind !== worn.kind) return false;
  if (look.kind === "gradient" && worn.kind === "gradient") return look.id === worn.id;
  return true;
}
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { LookThumb } from "./look-thumb";
import { Row, SettingsGroup } from "./settings-shell";

/** What is behind the app, in one word. A thumbnail shows the scene but cannot
 *  say which KIND it is — "composed scene" and "gradient" can look identical
 *  at 70px, and only one of them reopens in the layer composer. */
const BACKDROP_LABEL: Record<Look["backdrop"]["kind"], string> = {
  none: "no backdrop",
  gradient: "gradient",
  "custom-gradient": "custom gradient",
  image: "image",
  scene: "composed scene",
};

/**
 * WHAT A LOOK CARRIES, IN ONE LINE: its palette, its scene, its two faces.
 *
 * The palette is named by matching each embedded half back against the library
 * (a Look stores its halves CONCRETE, never a theme id — see lib/looks.ts), so
 * a look built from Ember says "Ember", a MIXED pair says both, and a palette
 * that matches nothing says so rather than claiming a name it does not have.
 */
function lookSummary(look: Look, themes: readonly ThemeDefinition[]): string {
  const light = matchThemeHalf(look.theme.light, themes, "light")?.label;
  const dark = matchThemeHalf(look.theme.dark, themes, "dark")?.label;
  const palette = light && dark ? (light === dark ? light : `${light} / ${dark}`) : "a palette of its own";
  const sans = look.fontSans === "custom" ? look.fontSansCustom || "a custom face" : SANS_LABEL[look.fontSans];
  const mono = look.fontMono === "custom" ? look.fontMonoCustom || "a custom face" : MONO_LABEL[look.fontMono];
  return `${palette} · ${BACKDROP_LABEL[look.backdrop.kind]} · ${sans} / ${mono}`;
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
  /** What the bundle carries — built by the caller, which is where the theme
   *  library the palette is named against already lives. */
  summary: string;
  /** The window has this look on. */
  worn: boolean;
  onWear: () => void;
  /** Absent for a starter: it is a recipe this build rebuilds every load, not
   *  a card, so there is nothing of yours to rename. */
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
          ? `“${state.look.label}” — ${BACKDROP_LABEL[state.look.backdrop.kind]}${following ? " · changing anything here stops following" : ""}`
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
  const { activeId, active, themes } = useThemeLibrary();
  /** What a fresh snapshot is called: the palette it was taken from, or the
   *  honest "Mixed look" when the two halves disagree. */
  const wornThemeLabel = themes.find((theme) => theme.id === activeId)?.label ?? "Mixed look";
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
    // Shelved, then worn: importing a look is asking to see it.
    if (commit(next)) onWear(look);
  };

  /** A photograph of every appearance store, shelved. A fresh id every time —
   *  Save means "keep this one too", never "overwrite the last one". */
  const saveLook = () => {
    const next = upsertLook(looks, captureLook(wornThemeLabel));
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
      description="A look is a theme pair — the light palette and the dark one — with the backdrop, the accent, the type and the depth saved around them. Wear one to put the lot on."
      action={
        <div className="flex items-center gap-2">
          <span className="font-mono text-3xs tracking-[0.08em] text-muted-foreground/60 uppercase tabular-nums">
            {looks.length + STARTER_LOOKS.length}
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
          summary={lookSummary(look, themes)}
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
      {/* A starter carries a STABLE id, so wearing Dusk twice updates the one
          library theme it installs instead of breeding a second one called
          Dusk. Save mints a fresh id, which is the moment a starter stops being
          a recipe and becomes a card of your own — which is also why a starter
          has no rename, export or delete: there is no card to act on yet. */}
      {STARTER_LOOKS.map((look) => (
        <LookRow key={look.id} look={look} summary={lookSummary(look, themes)} worn={worn(look)} onWear={() => onWear(look)} />
      ))}
    </SettingsGroup>
  );
}

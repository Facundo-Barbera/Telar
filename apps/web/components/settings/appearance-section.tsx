"use client";

/**
 * APPEARANCE — one write model, and the app is the preview.
 *
 * The previous studio interleaved two kinds of control: LIVE ones (the theme
 * library, the backdrop composer, wearing a Look) that retinted the app the
 * moment you touched them, and DRAFT ones (the colour rows, the chat, the
 * type) that painted a mock stage and waited on Apply. Two colour editors,
 * three copies of the preset grid and three Strength sliders later, the split
 * was the pane's whole difficulty. So now there is ONE RULE:
 *
 *   EVERYTHING ON THIS PANE EDITS THE DRAFT. The only things that write the
 *   live stores are Apply, the colour scheme, and the desktop window group —
 *   the scheme because it is which half you are LOOKING AT rather than part
 *   of a look, the window group because it is a property of the machine.
 *
 * AND THE APP IS THE PREVIEW. While a draft exists it is painted onto the
 * document itself (lib/studio-preview.ts) — hover states, text size, blur and
 * all sixteen tokens, judged on the real thing. Discard replays the stores and
 * the app snaps back. Nothing persists until Apply, so trying four ugly ideas
 * still costs nothing; you just get to SEE them properly now.
 *
 * SOURCES LOAD INTO THE DRAFT. A theme card, a Look card, an import — clicking
 * one used to write the live stores; now it loads the palette (or the whole
 * look) into the draft, previewed instantly. That kills the old dead end where
 * the studio could only ever start from whatever was already live.
 *
 * APPLY WEARS; SAVE SHELVES. Apply is `applyLook` and nothing else — it no
 * longer mints a shelf card per press. "Save look" is the explicit act, and
 * because a draft opened from a Look keeps its id, saving updates that card in
 * place instead of duplicating it.
 *
 * THE DRAFT SURVIVES NAVIGATION (written through to storage, restored on
 * mount) and EVERY EDIT IS UNDOABLE — a bounded history whose entries coalesce
 * while a slider is being dragged.
 *
 * THE PANE READS TOP TO BOTTOM AS THE WORK ITSELF: start from something (the
 * Looks shelf, which is never empty), change it (one of four tools, each
 * getting the whole width), keep it (Apply or Save, in the masthead). The
 * designer is the fourth TOOL rather than a permanent half of the screen —
 * welding it in place cost every other tool half its measure, and a pane where
 * two unrelated things always shout at once is the noise this rebuild set out
 * to delete.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ImageIcon, MonitorIcon, PaletteIcon, SparklesIcon, TypeIcon, Undo2Icon } from "lucide-react";
import { useAppearance, type Frost } from "@/lib/appearance";
import { desktopAppearance } from "@/lib/desktop-appearance";
import {
  applyLook,
  LOOKS_FULL_MESSAGE,
  LOOKS_QUOTA_MESSAGE,
  upsertLook,
  useLooks,
  writeLooks,
  type Look,
} from "@/lib/looks";
import {
  draftFromLook,
  loadThemeHalfIntoDraft,
  loadThemeIntoDraft,
  newDraftFromCurrent,
  patchDraftHalf,
  readStudioDraft,
  replaceDraftBackdrop,
  setDraftLabel,
  writeStudioDraft,
  type StudioDraft,
  type StudioMode,
} from "@/lib/studio-draft";
import { clearPreview, previewLook } from "@/lib/studio-preview";
import { THEME_TOKENS, useThemeLibrary, type ThemeDefinition } from "@/lib/theme-palettes";
import { ThemeControl } from "@/components/theme-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { Row, Segmented, ToggleRow } from "./settings-shell";
import { LooksSection } from "./looks-section";
import { ThemeLibrary } from "./theme-library";
import { DesignerChat } from "./studio/chat";
import { BackdropTool } from "./studio/backdrop-tool";
import { ColourTool, ShowThroughTool, TypeTool } from "./studio/tools";

// Same idiom as updates-section.tsx: whether there is a shell at all is an
// external fact, present before React ran, and it never changes.
const subscribeToNothing = () => () => {};
const bridgeIsPresent = () => desktopAppearance() !== undefined;
const noBridgeOnTheServer = () => false;

type Tab = "colour" | "backdrop" | "type" | "window" | "designer";

/** How long a gap between edits starts a NEW undo step. Inside it, edits
 *  coalesce — a colour-picker drag is one step, not ninety. */
const UNDO_COALESCE_MS = 800;
const MAX_UNDO = 50;

/** How long after the last edit the draft is written through to storage. */
const PERSIST_DEBOUNCE_MS = 400;

export function AppearanceSection() {
  const { appearance, setAppearance } = useAppearance();
  const { activeId, themes, saveCustom, setActive } = useThemeLibrary();
  const looks = useLooks();

  const hasBridge = useSyncExternalStore(subscribeToNothing, bridgeIsPresent, noBridgeOnTheServer);
  // `supported` has to be ASKED (macOS or not), so the row waits for the
  // answer rather than flashing a control that then disappears.
  const [windowSupported, setWindowSupported] = useState(false);

  const [tab, setTab] = useState<Tab>("colour");
  /** Which half the preview wears while a draft is open. Sticky once picked —
   *  a preview that flipped when the OS crossed into evening would be worse
   *  than one that stays where it was put. */
  const [pickedMode, setPickedMode] = useState<StudioMode>();
  /** Undefined means "nothing drafted" — the pane shows the live truth. */
  const [draft, setDraft] = useState<StudioDraft>();
  const [notice, setNotice] = useState<string>();

  /** The undo stack. Each entry is the draft BEFORE an edit step; undefined
   *  marks the clean state before the first fork. `undoDepth` mirrors its
   *  length as state, because render must not read a ref. */
  const history = useRef<Array<StudioDraft | undefined>>([]);
  const [undoDepth, setUndoDepth] = useState(0);
  const lastEditAt = useRef(0);

  const mounted = useSyncExternalStore(subscribeToNothing, () => true, () => false);
  const documentIsDark = useSyncExternalStore(
    subscribeToNothing,
    () => document.documentElement.classList.contains("dark"),
    () => false,
  );
  const mode: StudioMode = pickedMode ?? (documentIsDark ? "dark" : "light");

  useEffect(() => {
    if (!hasBridge) return;
    let live = true;
    void desktopAppearance()
      ?.get()
      .then((state) => {
        if (!live) return;
        setWindowSupported(state.supported);
        // The shell's copy wins on entry: it is what the window was actually
        // built with, and a stale localStorage copy must not disagree.
        setAppearance({ translucent: state.translucent, frost: state.frost });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // setAppearance is stable; run once per bridge discovery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasBridge]);

  // A draft left behind by the last visit — same id, same shelf card, same
  // conversation. Restored once on mount; a one-shot setState here cannot
  // cascade, and reading storage during render would break hydration.
  useEffect(() => {
    const kept = readStudioDraft();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (kept) setDraft(kept);
  }, []);

  // THE PREVIEW: the draft on the document, in the picked half; taken off when
  // the draft goes, and when the pane unmounts (the draft itself survives in
  // storage — only the paint is removed).
  useEffect(() => {
    if (draft) previewLook(draft, pickedMode);
    else clearPreview();
  }, [draft, pickedMode]);
  useEffect(() => () => clearPreview(), []);

  // Write-through, debounced: a slider drag is one write, not ninety.
  useEffect(() => {
    if (draft === undefined) return;
    const timer = window.setTimeout(() => writeStudioDraft(draft), PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft]);

  /** The live look, re-photographed whenever any store behind it moves. When
   *  the worn theme came from a Look, the capture keeps that Look's id, so
   *  "Save look" updates the card you are wearing rather than duplicating it. */
  const live = useMemo(
    () => {
      if (!mounted) return undefined;
      const worn = activeId ? themes.find((theme) => theme.id === activeId) : undefined;
      const captured = newDraftFromCurrent(worn?.label ?? "Mixed look");
      if (activeId?.startsWith("look-")) {
        const lookId = activeId.slice("look-".length);
        if (looks.some((look) => look.id === lookId)) return { ...captured, id: lookId };
      }
      return captured;
    },
    // The snapshots ARE the dependency even though the capture reads storage:
    // each is a stable identity from its own store and changes exactly when
    // that store is written. The rule can only see that they are unread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mounted, appearance, activeId, themes, looks],
  );

  const current = draft ?? live;
  const dirty = draft !== undefined;

  /** Every draft write funnels here: history, then state. */
  const edit = useCallback(
    (next: StudioDraft) => {
      setNotice(undefined);
      const now = Date.now();
      if (now - lastEditAt.current > UNDO_COALESCE_MS) {
        history.current.push(draft);
        if (history.current.length > MAX_UNDO) history.current.shift();
        setUndoDepth(history.current.length);
      }
      lastEditAt.current = now;
      setDraft(next);
    },
    [draft],
  );

  const undo = useCallback(() => {
    if (history.current.length === 0) return;
    const previous = history.current.pop();
    setUndoDepth(history.current.length);
    lastEditAt.current = 0;
    setDraft(previous);
    if (previous === undefined) writeStudioDraft(undefined);
  }, []);

  // Cmd/Ctrl+Z undoes a draft step — unless focus is in a text field, whose
  // own undo must keep working.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== "z" || event.shiftKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

  const discard = () => {
    history.current = [];
    setUndoDepth(0);
    setDraft(undefined);
    writeStudioDraft(undefined);
    setNotice(undefined);
  };

  /** Wear the draft: every store written through applyLook, nothing shelved.
   *  The preview effect clears itself once the draft goes, replaying the
   *  stores — which now hold exactly what the preview was showing. */
  const apply = () => {
    if (!draft) return;
    const worn = applyLook(draft, { saveCustom, setActive }, setAppearance);
    history.current = [];
    setUndoDepth(0);
    setDraft(undefined);
    writeStudioDraft(undefined);
    setNotice(worn);
  };

  /** Shelve the draft (or, with nothing drafted, the live look). Same id →
   *  same card: editing a saved Look updates it in place. */
  const saveLook = () => {
    const look = current;
    if (!look) return;
    const next = upsertLook(looks, look);
    if (next === undefined) {
      setNotice(LOOKS_FULL_MESSAGE);
      return;
    }
    setNotice(writeLooks(next) ? undefined : LOOKS_QUOTA_MESSAGE);
  };

  const openLook = (look: Look) => edit(draftFromLook(look));
  const pickTheme = (theme: ThemeDefinition) => current && edit(loadThemeIntoDraft(current, theme));
  const pickThemeHalf = (half: StudioMode, theme: ThemeDefinition) => current && edit(loadThemeHalfIntoDraft(current, half, theme));

  const setTranslucent = (next: boolean) => {
    setAppearance({ translucent: next });
    void desktopAppearance()?.set({ translucent: next });
  };

  const setFrost = (next: Frost) => {
    setAppearance({ frost: next });
    void desktopAppearance()?.set({ frost: next });
  };

  return (
    <div className="flex flex-col gap-3">
      {/* THE MASTHEAD — what you are editing, and what can be done with it.
          A quiet title that finds its border under the cursor, the state as a
          mono chip, actions on the right: a session's header, for a look. */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="h-8 max-w-64 flex-1 border-transparent bg-transparent font-heading text-base font-semibold tracking-tight shadow-none hover:border-border focus:border-border dark:bg-transparent"
          value={current?.label ?? ""}
          placeholder="Name this look"
          aria-label="Look name"
          disabled={!current}
          onChange={(event) => current && edit(setDraftLabel(current, event.target.value))}
        />
        {dirty ? (
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[0.625rem] tracking-[0.08em] text-warning uppercase">
            <span className="size-1.5 rounded-full bg-warning" />
            Previewing
          </span>
        ) : (
          <span className="shrink-0 font-mono text-[0.625rem] tracking-[0.08em] text-muted-foreground uppercase">Worn</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Segmented<StudioMode>
            value={mode}
            onChange={setPickedMode}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
          {dirty && (
            <>
              <Button size="sm" variant="ghost" title="Undo the last edit (⌘Z)" disabled={undoDepth === 0} onClick={undo}>
                <Undo2Icon /> Undo
              </Button>
              <Button size="sm" variant="ghost" onClick={discard}>
                Discard
              </Button>
            </>
          )}
          <Button size="sm" variant="outline" onClick={saveLook}>
            Save look
          </Button>
          {dirty && (
            <Button size="sm" onClick={apply}>
              Apply
            </Button>
          )}
        </div>
      </div>

      {notice && <p className="text-xs text-warning">{notice}</p>}

      <LooksSection onOpen={openLook} />

      {/* FOUR TOOLS, ONE AT A TIME, EACH THE FULL WIDTH.
          The designer used to be welded to the left half of this pane, which
          cost every other tool half its measure — that is what squeezed the
          scene composer's rows into a column of one word each. It is a TOOL
          like the others: you go to it, and while you are not there the
          palette and the scene get the whole page. */}
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex">
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: "colour", label: <><PaletteIcon className="size-3.5" /> Colour</> },
            { value: "backdrop", label: <><ImageIcon className="size-3.5" /> Backdrop</> },
            { value: "type", label: <><TypeIcon className="size-3.5" /> Type</> },
            { value: "window", label: <><MonitorIcon className="size-3.5" /> Window</> },
            { value: "designer", label: <><SparklesIcon className="size-3.5" /> Designer</> },
          ]}
        />
        </div>

        {tab === "colour" && current && (
          <>
            <Panel>
              <PanelHeader icon={<PaletteIcon />} label={`Palette · ${mode}`} count={THEME_TOKENS.length} />
              <PanelBody>
                <ColourTool draft={current} onDraft={edit} mode={mode} />
              </PanelBody>
            </Panel>
            {/* The library is where a palette comes FROM: a card loads both
                halves into the draft; an orb loads one. */}
            <ThemeLibrary onPick={pickTheme} onPickHalf={pickThemeHalf} />
          </>
        )}

        {tab === "backdrop" && current && (
          <BackdropTool
            value={current.backdrop}
            mode={mode}
            onChange={(backdrop) => edit(replaceDraftBackdrop(current, backdrop))}
            // A palette taken from the picture lands on the draft's two halves
            // like any other edit — undoable, and never a new library entry.
            // Only the halves: the look keeps the name it was given, because
            // naming it was a separate decision.
            onThemeHalves={(theme) => edit(patchDraftHalf(patchDraftHalf(current, "light", theme.light), "dark", theme.dark))}
            footer={<ShowThroughTool draft={current} onDraft={edit} />}
          />
        )}

        {tab === "type" && current && (
          <Panel>
            <PanelHeader icon={<TypeIcon />} label="Type" />
            <PanelBody>
              <TypeTool draft={current} onDraft={edit} />
            </PanelBody>
          </Panel>
        )}

        {/* THE WINDOW IS NOT A LOOK, so it is not a look tool. It lived under
            "Type" for no reason anyone could reconstruct, which is the kind of
            filing that teaches a reader the grouping is arbitrary. None of it
            travels in a Look: the scheme is which half THIS window wears, and
            translucency is a property of the machine — macOS only, stored by
            the shell, and turning it on rebuilds the window.

            HOW MUCH SHOWS THROUGH IS NOT HERE, though it reads like it should
            be. It is the one member of this group that DOES travel in a Look,
            so it is a draft control and lives with the backdrop it thins. Two
            sliders for one value is the confusion this pane was rebuilt to
            delete — and the draft's copy wins the preview anyway, so the live
            one silently did nothing while a draft was open. */}
        {tab === "window" && (
          <Panel>
            <PanelHeader icon={<MonitorIcon />} label="Window" />
            <PanelBody>
              <Row label="Colour scheme" control={<ThemeControl />} />
              {hasBridge && windowSupported ? (
                <>
                  <ToggleRow
                    label="Translucency"
                    hint="Rebuilds the window."
                    checked={appearance.translucent}
                    onCheckedChange={setTranslucent}
                  />
                  {appearance.translucent && (
                    <Row
                      label="Glass"
                      control={
                        <Segmented<Frost>
                          value={appearance.frost}
                          onChange={setFrost}
                          options={[
                            { value: "blur", label: "Blur" },
                            { value: "clear", label: "Clear" },
                          ]}
                        />
                      }
                    />
                  )}
                </>
              ) : (
                <p className="px-3 pb-3 text-xs text-muted-foreground">Translucency needs the macOS desktop app.</p>
              )}
            </PanelBody>
          </Panel>
        )}

        {tab === "designer" && current && <DesignerChat draft={current} onDraft={edit} mode={mode} className="h-[24rem]" />}
      </div>
    </div>
  );
}

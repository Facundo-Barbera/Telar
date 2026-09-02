"use client";

/**
 * APPEARANCE — a theme editor, not a list of settings.
 *
 * This pane used to be seven stacked groups in a 42rem reading column: scheme,
 * looks, themes, designer, backdrop, type, window. Every one of them was a
 * correct control and the whole was unusable, because designing a look is not
 * a sequence of decisions — it is one decision watched from several angles at
 * once. So the pane is now an editor: a STAGE showing the look, a DESIGNER
 * beneath it that edits what the stage shows, and an INSPECTOR beside it whose
 * tabs hold the same controls that used to be stacked. It opts out of the
 * shell's reading column (`wide` in settings-shell.tsx) because three columns
 * folded into one is a worse version of each.
 *
 * TWO KINDS OF CONTROL, AND THE PAGE SAYS WHICH IS WHICH.
 *
 *   LIVE — the theme library, the backdrop composer, the colour scheme, the
 *   window translucency, and wearing a saved Look. These write their stores
 *   the moment you touch them, exactly as they always have. They are how you
 *   change the app you are sitting in, and retinting the window IS the
 *   feedback.
 *
 *   DRAFT — the colour rows, the designer chat, the accent, the typefaces, the
 *   text size, the strength. These write a `StudioDraft` (lib/studio-draft.ts),
 *   which is an unapplied `Look`. Nothing outside this pane sees them until
 *   Apply. That is what lets the chat try four ideas without making anyone
 *   live in the three that were wrong.
 *
 * WHY "DIRTY" IS `draft !== undefined` RATHER THAN A COMPARISON. While nothing
 * has been drafted, the stage paints a FRESH capture of the live stores, so the
 * page reads as "this is what you are wearing" and follows every live control
 * without a sync step. The first draft edit forks that capture; Discard drops
 * the fork and the page snaps back to the live truth. There is no third state
 * where a stale draft claims to be the current look.
 *
 * APPLY IS `applyLook` PLUS A SHELF ENTRY. The draft is already a Look, so
 * applying it is the same call the Looks strip makes when you wear a card —
 * and saving it means the thing you just spent ten minutes designing survives
 * the next time you try something. A full shelf or a quota refusal is reported
 * on the line under the header; the look is worn either way.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { MonitorIcon, SunMoonIcon } from "lucide-react";
import {
  MAX_TRANSLUCENCY,
  MIN_TRANSLUCENCY,
  useAppearance,
  type Frost,
} from "@/lib/appearance";
import { useBackdrop } from "@/lib/backdrop";
import { desktopAppearance } from "@/lib/desktop-appearance";
import {
  applyLook,
  LOOKS_FULL_MESSAGE,
  LOOKS_QUOTA_MESSAGE,
  upsertLook,
  useLooks,
  writeLooks,
} from "@/lib/looks";
import { newDraftFromCurrent, setDraftLabel, type StudioDraft, type StudioMode } from "@/lib/studio-draft";
import { useThemeLibrary } from "@/lib/theme-palettes";
import { ThemeControl } from "@/components/theme-control";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Row, Segmented, SettingsGroup, ToggleRow } from "./settings-shell";
import { LooksSection } from "./looks-section";
import { ThemeLibrary } from "./theme-library";
import { BackdropSection } from "./backdrop-section";
import { Stage } from "./studio/stage";
import { DesignerChat } from "./studio/chat";
import { ColourTool, SceneTool, TypeTool } from "./studio/tools";

// Same idiom as updates-section.tsx: whether there is a shell at all is an
// external fact, present before React ran, and it never changes.
const subscribeToNothing = () => () => {};
const bridgeIsPresent = () => desktopAppearance() !== undefined;
const noBridgeOnTheServer = () => false;

type Tab = "colours" | "scene" | "type";

const STAGE_HINT =
  "The stage shows the draft. Colour rows, the designer, the accent and the type below stage here until you apply them; the theme library, the backdrop composer and the colour scheme change the app straight away.";

export function AppearanceSection() {
  const { appearance, setAppearance } = useAppearance();
  // Subscribed rather than read: these are what a fresh capture depends on, so
  // a live control anywhere on the page has to re-run it.
  const { activeId, themes, saveCustom, setActive } = useThemeLibrary();
  const { backdrop } = useBackdrop();
  const looks = useLooks();

  const hasBridge = useSyncExternalStore(subscribeToNothing, bridgeIsPresent, noBridgeOnTheServer);
  // `supported` has to be ASKED (macOS or not), so the row waits for the
  // answer rather than flashing a control that then disappears.
  const [windowSupported, setWindowSupported] = useState(false);

  const [tab, setTab] = useState<Tab>("colours");
  /** Undefined until the reader picks a half: the stage then opens on the one
   *  the window is already in, so the first thing it shows is comparable to
   *  what surrounds it. A pick is sticky — the stage is for judging a draft,
   *  and having it flip when the OS crosses into evening would be worse than
   *  having it stay where it was put. */
  const [pickedMode, setPickedMode] = useState<StudioMode>();
  /** Undefined means "nothing drafted" — see the header. */
  const [draft, setDraft] = useState<StudioDraft>();
  const [notice, setNotice] = useState<string>();

  /** Capturing reads localStorage, which the server has none of; the stage
   *  waits for the client rather than rendering a default look and swapping.
   *  The same external-fact idiom the bridge check above uses. */
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

  /** The live look, re-photographed whenever any store behind it moves. */
  const live = useMemo(
    () => {
      if (!mounted) return undefined;
      const worn = activeId ? themes.find((theme) => theme.id === activeId) : undefined;
      return newDraftFromCurrent(worn?.label ?? "Mixed look");
    },
    // The snapshots ARE the dependency even though the capture reads storage
    // rather than them: each is a stable identity from its own store, changes
    // exactly when that store is written, and is therefore the signal that the
    // photograph is stale. The rule can only see that they are unread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mounted, appearance, backdrop, activeId, themes],
  );

  const current = draft ?? live;
  const dirty = draft !== undefined;

  const edit = (next: StudioDraft) => {
    setNotice(undefined);
    setDraft(next);
  };

  const discard = () => {
    setDraft(undefined);
    setNotice(undefined);
  };

  const apply = () => {
    if (!draft) return;
    // The wear first, then the shelf: a look that would not fit in storage is
    // still a look worth wearing, and applyLook already degrades the part of
    // itself that cannot be written.
    const worn = applyLook(draft, { saveCustom, setActive }, setAppearance);
    const next = upsertLook(looks, draft);
    const shelved = next === undefined ? LOOKS_FULL_MESSAGE : writeLooks(next) ? undefined : LOOKS_QUOTA_MESSAGE;
    setNotice(worn ?? shelved);
    setDraft(undefined);
  };

  const setTranslucent = (next: boolean) => {
    setAppearance({ translucent: next });
    void desktopAppearance()?.set({ translucent: next });
  };

  const setFrost = (next: Frost) => {
    setAppearance({ frost: next });
    void desktopAppearance()?.set({ frost: next });
  };

  return (
    <div className="flex flex-col gap-4">
      {/* THE HEADER carries the draft's identity and, only while there IS a
          draft, the two things you can do with it. A page that always showed
          Apply would be asking to apply the thing already applied. */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="h-8 max-w-64 flex-1 font-medium"
          value={current?.label ?? ""}
          placeholder="Name this look"
          aria-label="Look name"
          disabled={!current}
          onChange={(event) => current && edit(setDraftLabel(current, event.target.value))}
        />
        <Segmented<StudioMode>
          value={mode}
          onChange={setPickedMode}
          options={[
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
        <div className="ml-auto flex items-center gap-2">
          {dirty ? (
            <>
              <Badge variant="outline" className="gap-1.5 text-[10px]">
                <span className="size-1.5 rounded-full bg-warning" />
                Draft
              </Badge>
              <Button size="sm" variant="ghost" onClick={discard}>
                Discard
              </Button>
              <Button size="sm" onClick={apply}>
                Apply
              </Button>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">This is what you are wearing.</span>
          )}
        </div>
      </div>

      {notice && <p className="text-xs text-warning">{notice}</p>}

      <LooksSection />

      {/* Two columns on a wide window, stacked on a narrow one — the stage is
          the widest thing here and must not be squeezed into a third. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[2fr_1fr]">
        <div className="flex min-w-0 flex-col gap-3">
          {current ? (
            <Stage draft={current} mode={mode} />
          ) : (
            <div className="aspect-[16/10] w-full rounded-xl bg-muted/40 ring-1 ring-foreground/10" />
          )}
          <p className="text-[11px] leading-snug text-muted-foreground">{STAGE_HINT}</p>
          {current && <DesignerChat draft={current} onDraft={edit} />}
        </div>

        <div className="min-w-0">
          <div className="mb-3">
            <Segmented<Tab>
              value={tab}
              onChange={setTab}
              options={[
                { value: "colours", label: "Colours" },
                { value: "scene", label: "Scene" },
                { value: "type", label: "Type" },
              ]}
            />
          </div>

          {tab === "colours" && (
            <>
              {current && (
                <SettingsGroup title="Draft palette" description="Sixteen surfaces, edited on the draft.">
                  <ColourTool draft={current} onDraft={edit} mode={mode} />
                </SettingsGroup>
              )}
              {/* LIVE: the library is where a palette comes FROM. Clicking a
                  theme wears it, and the stage re-photographs it. */}
              <ThemeLibrary />
            </>
          )}

          {tab === "scene" && (
            <>
              {current && (
                <SettingsGroup title="Draft backdrop" description="One gradient under the draft.">
                  <SceneTool draft={current} onDraft={edit} mode={mode} />
                </SettingsGroup>
              )}
              {/* LIVE: the full composer — layers, images, tiling. */}
              <BackdropSection />
            </>
          )}

          {tab === "type" && (
            <>
              <SettingsGroup title="Colour scheme" description="Which half of every theme this window wears. Applied immediately.">
                <Row
                  label="Scheme"
                  hint="System follows the OS setting. The Light/Dark toggle above only moves the stage."
                  icon={SunMoonIcon}
                  control={<ThemeControl />}
                />
              </SettingsGroup>

              {current && (
                <SettingsGroup title="Draft type" description="Accent, typefaces, size and strength — staged until you apply.">
                  <TypeTool draft={current} onDraft={edit} />
                </SettingsGroup>
              )}

              {hasBridge && windowSupported && (
                <SettingsGroup title="Window" description="Desktop app only, and never part of a look — this is a property of the machine.">
                  <ToggleRow
                    label="Translucency"
                    hint="The desktop shows through the canvas and the sidebar; cards and text stay opaque. Turning it on rebuilds the window — transparency is decided when a window is created."
                    icon={MonitorIcon}
                    checked={appearance.translucent}
                    onCheckedChange={setTranslucent}
                  />
                  {appearance.translucent && (
                    <Row
                      label="Glass"
                      hint="Blur is macOS's frosted vibrancy — it brightens what it blurs. Clear shows the desktop crisp, tinted only by the app."
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
                  {appearance.translucent && (
                    <Row
                      label="Strength"
                      hint="How much desktop shows through. Applies live — the draft carries its own copy of this number."
                      control={
                        <div className="flex items-center gap-2.5">
                          <input
                            type="range"
                            min={MIN_TRANSLUCENCY}
                            max={MAX_TRANSLUCENCY}
                            step={5}
                            value={appearance.translucencyLevel}
                            onChange={(event) => setAppearance({ translucencyLevel: Number(event.target.value) })}
                            className="w-36 accent-primary"
                            aria-label="Translucency strength"
                          />
                          <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{appearance.translucencyLevel}%</span>
                        </div>
                      }
                    />
                  )}
                </SettingsGroup>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";

// Shared settings frame — ported verbatim from the frozen app's
// components/settings/settings-shell.tsx. A fixed side-nav (never scrolls) and
// an internally-scrolling content pane with a sticky sub-header. Colors come
// from theme tokens only; nothing hard-codes a palette.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeftIcon, CircleAlertIcon, Undo2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import { settingsRowId, type SettingsSearchEntry, type SettingsSearchIndex } from "@/lib/settings-search";
import { SettingsSearchNav } from "./settings-search-nav";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { APP_SIDEBAR_STORAGE_KEY, APP_SIDEBAR_MAIN_MIN_WIDTH, clampSidebarWidth, keepsRoomForMain, setSidebarWidth, SIDEBAR_RESIZE_MIN_WIDTH, useSidebarPrefs } from "@/lib/sidebar-width";

export type SettingsSection = {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  count?: number;
  group?: string; // optional side-nav grouping header
};

/**
 * WHERE A ROW IS, WITHOUT EVERY ROW BEING TOLD.
 *
 * A row's anchor has to name its pane and its group, or two panes with a
 * "Model" row cannot both be linked to. Neither fact is a row's business: the
 * pane is whatever the shell has selected and the group is the heading directly
 * above, and threading both through every `<Row>` in a dozen section files
 * would be a prop nobody reads and one more thing to get wrong on a move.
 *
 * So the frame states them once — the shell for the pane, the group for its own
 * title — and `Row` derives the id it renders from `lib/settings-search.ts`,
 * which is the SAME function the search index uses to point at rows that have
 * never been rendered. Outside a shell (a Row mounted alone in a test) both are
 * undefined and the id is the label's slug, which is still unique there.
 */
const SettingsPaneContext = createContext<string | undefined>(undefined);
const SettingsGroupContext = createContext<string | undefined>(undefined);

/**
 * ARRIVING AT A ROW: scroll it to the middle, focus it, say so once.
 *
 * All three, because each covers a different reader. Centring is what makes a
 * row findable on a pane of twenty; focus is what a screen reader follows and
 * where the next Tab continues from; the pulse is what tells a sighted reader
 * WHICH of the rows now on screen was the one they asked for — a scroll alone
 * leaves that to guesswork.
 *
 * THE PULSE IS RE-ARMED BY HAND. Re-adding a class the element already carries
 * does not restart a CSS animation, so choosing the same result twice would
 * flash once and then go quiet; removing it and reading `offsetWidth` forces
 * the reflow that makes the second press look like the first.
 *
 * Both motions are dropped for `prefers-reduced-motion`: the jump becomes an
 * instant one and the pulse does not run. The row is still centred and still
 * focused, which is the part that carries the meaning.
 */
function revealSettingsRow(id: string): boolean {
  const row = document.getElementById(id);
  if (!row) return false;
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  row.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
  // `preventScroll`, or focusing would jump the pane a second time and undo the
  // centring we just asked for.
  row.focus({ preventScroll: true });
  if (!still) {
    row.classList.remove("settings-search-target-pulse");
    void row.offsetWidth;
    row.classList.add("settings-search-target-pulse");
    row.addEventListener("animationend", () => row.classList.remove("settings-search-target-pulse"), { once: true });
  }
  return true;
}

/** How long to keep looking for a row after switching to its pane. Sections
 *  fetch before they render — Updates has no rows until the shell answers — so
 *  the anchor may be a few frames or a round-trip away. */
const REVEAL_TIMEOUT_MS = 2_000;

/**
 * WHICH PANES HAVE DEFAULTS, WITHOUT THE HEADER BEING TOLD.
 *
 * `Restore defaults` is page-scoped, and the page is a set of sections the
 * shell renders by condition — so the header cannot answer "does this pane
 * have anything to restore" without a table of pane ids that would have to be
 * maintained beside every section it names. It would also be wrong the moment
 * a section's defaults depend on state (Updates has none; Generated text has
 * four).
 *
 * So the sections declare it. A section that knows its defaults calls
 * `useRestoreDefaults`, which registers while it is MOUNTED — and only the
 * active pane's sections are mounted, because the panes render conditionally.
 * The header shows the action when the set is non-empty and runs every
 * registration when it is pressed. A pane of facts (This build) registers
 * nothing and gets no button, without saying so anywhere.
 */
type RestoreRegistry = { add: (restore: () => void | Promise<void>) => () => void };
const SettingsRestoreContext = createContext<RestoreRegistry | undefined>(undefined);

/**
 * Offer this section's defaults to the pane's `Restore defaults`.
 *
 * The callback is read through a ref so a section may close over live state
 * without re-registering on every render — the registration's identity is what
 * the shell removes on unmount.
 */
export function useRestoreDefaults(restore: () => void | Promise<void>): void {
  const registry = useContext(SettingsRestoreContext);
  const latest = useRef(restore);
  useEffect(() => {
    latest.current = restore;
  });
  useEffect(() => {
    if (!registry) return;
    return registry.add(() => latest.current());
  }, [registry]);
}

export function SettingsShell({
  title,
  subtitle,
  sections,
  active,
  onSelect,
  backHref,
  headerActions,
  search,
  wide,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  sections: SettingsSection[];
  active: string;
  onSelect: (id: string) => void;
  backHref?: string;
  headerActions?: ReactNode;
  /**
   * Rows this shell's panes hold, for the search field at the top of the nav.
   * Omitted where there is no index to offer — project settings is a handful of
   * panes with a project id in every route, and is not indexed (see
   * settings-registry.ts). Without it the nav is exactly what it was.
   */
  search?: SettingsSearchIndex;
  /**
   * OPT OUT OF THE READING COLUMN. Every pane here is a list of rows, and a
   * list of rows wants a measure — hence the `max-w-2xl` that has held since
   * this frame was ported. Appearance stopped being a list: it is an editor
   * with a preview, a transcript and an inspector beside each other, and three
   * columns folded into 42rem is a worse version of each. This flag is the
   * ONE exception, asked for per pane rather than made the default, so no
   * other section's measure moves.
   */
  wide?: boolean;
  children: ReactNode;
}) {
  const activeSection = sections.find((s) => s.id === active) ?? sections[0];
  /**
   * The mounted sections that know their own defaults — see
   * `useRestoreDefaults`. Held as an array rather than a Set so the header
   * re-renders when membership changes, which is what makes the action appear
   * and disappear with the pane.
   */
  const [restorers, setRestorers] = useState<ReadonlyArray<() => void | Promise<void>>>([]);
  const restoreRegistry = useMemo<RestoreRegistry>(
    () => ({
      add: (restore) => {
        setRestorers((current) => [...current, restore]);
        return () => setRestorers((current) => current.filter((entry) => entry !== restore));
      },
    }),
    [],
  );
  /**
   * THE SAME WIDTH AS THE RAIL IT REPLACES. This nav stands where the app
   * sidebar stood (see app-shell.tsx), and a fixed `w-60` beside the rail's
   * 16rem default — or whatever width the human dragged it to — made every
   * trip into Settings a 16px-plus jump. Reading the rail's own persisted
   * record keeps the left edge still across the switch. Null (nothing stored,
   * and every server render) is the rail's own default.
   */
  const prefsWidth = useSidebarPrefs(APP_SIDEBAR_STORAGE_KEY).width ?? SIDEBAR_RESIZE_MIN_WIDTH;
  const [dragWidth, setDragWidth] = useState<number>();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const navWidth = dragWidth ?? prefsWidth;

  useEffect(() => {
    if (dragWidth === undefined) return;
    const stop = () => {
      setSidebarWidth(APP_SIDEBAR_STORAGE_KEY, dragWidth);
      setDragWidth(undefined);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    const move = (event: PointerEvent) => {
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const current = dragWidth;
      const proposed = event.clientX - rect.left;
      const max = Math.max(SIDEBAR_RESIZE_MIN_WIDTH, rect.width - APP_SIDEBAR_MAIN_MIN_WIDTH);
      const next = clampSidebarWidth(proposed, SIDEBAR_RESIZE_MIN_WIDTH, max);
      if (keepsRoomForMain(current, next, rect.width, APP_SIDEBAR_MAIN_MIN_WIDTH)) setDragWidth(next);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [dragWidth]);

  /**
   * The row a search result asked for, held until it exists.
   *
   * Choosing a result switches panes, and the pane it switches to renders on
   * the next commit — and often fetches before it has any rows at all. So the
   * id is parked here and an animation-frame loop looks for it until it turns
   * up or the deadline passes; a row that never appears (its section is behind
   * a toggle that is off) costs a couple of seconds of looking and nothing
   * else, having already navigated to the right pane.
   */
  const [pendingRow, setPendingRow] = useState<string>();
  useEffect(() => {
    if (!pendingRow) return;
    const deadline = Date.now() + REVEAL_TIMEOUT_MS;
    let frame = 0;
    const look = () => {
      if (revealSettingsRow(pendingRow) || Date.now() > deadline) {
        setPendingRow(undefined);
        return;
      }
      frame = window.requestAnimationFrame(look);
    };
    frame = window.requestAnimationFrame(look);
    return () => window.cancelAnimationFrame(frame);
  }, [pendingRow]);

  const jumpTo = (entry: SettingsSearchEntry) => {
    onSelect(entry.pageId);
    setPendingRow(entry.id);
  };

  // Group the nav if any section declares a group; otherwise flat.
  const groups = sections.some((s) => s.group)
    ? Array.from(new Set(sections.map((s) => s.group ?? ""))).map((g) => ({
        group: g,
        items: sections.filter((s) => (s.group ?? "") === g),
      }))
    : [{ group: "", items: sections }];

  // The panes themselves — a value rather than inline JSX because search
  // REPLACES this list while a query is live, and the two states read better
  // side by side than as a condition wrapped around forty lines.
  const paneList = (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {groups.map(({ group, items }) => (
        <div key={group} className="flex flex-col gap-0.5">
          {group && (
            <div className="px-2 pb-1 text-[0.625rem] font-medium uppercase tracking-wider text-muted-foreground/60">{group}</div>
          )}
          {items.map((s) => {
            const Icon = s.icon;
            const on = s.id === active;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => onSelect(s.id)}
                className={cn(
                  "group flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors",
                  on ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                <Icon className={cn("size-4 shrink-0", on ? "text-foreground" : "text-muted-foreground/70")} />
                <span className="flex-1 truncate">{s.label}</span>
                {s.count != null && <span className="text-[0.6875rem] tabular-nums text-muted-foreground/60">{s.count}</span>}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );

  return (
    // TWO ISLANDS ON THE SHELL'S GROUND, like the cockpit. `data-surfaces` is
    // what tells app-shell.tsx to stop framing this route as one card and to
    // become the ground between the two drawn here (same radius, ring and
    // 8px gutter as the rail and the conversation card). Below `md` there are
    // no islands anywhere in the app: the nav keeps its hairline and the body
    // is the surface. `app-ground`: transparent in the desktop shell's
    // translucent mode — the body's single wash is the canvas (globals.css).
    <div
      data-surfaces
      ref={wrapperRef}
      className="app-ground flex h-full min-h-0 bg-background text-foreground md:gap-2 md:bg-transparent"
      // The rail's persisted width INCLUDES the 8px the floating primitive
      // pads on each side, so the card itself is 1rem narrower; the same
      // subtraction here keeps the content edge exactly where the session
      // inset's is across the switch.
      style={{ "--settings-nav-width": `${navWidth}px` } as CSSProperties}
    >
      {/* Side-nav — fixed, never scrolls the shell */}
      {/* `bg-sidebar` full-alpha: --sidebar is the one token the wash still
          thins under a backdrop, so a /40 here would multiply down to ~18%
          and vanish over wallpaper (the Phase-2 contract in globals.css).
          THE RAIL'S OWN SURFACE RECIPE on `md` — `bg-sidebar` plus a hairline
          ring and the inset's radius — so this island matches the one it
          replaces. `overflow-hidden` is what clips the drag band to the
          corners; the ring is a box-shadow and survives it. */}
      <nav
        className={cn(
          "flex w-[var(--settings-nav-width)] shrink-0 flex-col gap-4 overflow-x-hidden overflow-y-auto border-r border-border bg-sidebar p-3",
          "md:w-[calc(var(--settings-nav-width)-1rem)] md:rounded-xl md:border-r-0 md:shadow-sm md:ring-1 md:ring-sidebar-border",
        )}
      >
        {/*
          THIS NAV IS THE WINDOW'S LEFT EDGE, ALWAYS: settings screens mount no
          app rail (see app-shell.tsx) — this nav REPLACES it rather than
          standing beside it, so it is the strip that leaves room for the macOS
          traffic lights and is grabbable, unconditionally.

          THE BAND UNDER THE TRAFFIC LIGHTS IS THE APP'S, NOT THIS SCREEN'S.
          It is window decoration by adjacency, so it says what the app rail's
          band says — the static "Telar" wordmark, same type, same height —
          and nothing route-dependent. The road out lives at the BOTTOM of the
          nav (see below), where the app rail keeps its own meta-navigation.
        */}
        <div
          className={cn(
            "app-drag -m-3 mb-0 flex h-[var(--titlebar-height)] shrink-0 items-center border-b border-sidebar-border/60 px-3",
            // The inset is measured from the island, never less than the nav's
            // own padding. `+4px` is this header's existing nudge, unchanged:
            // `-m-3` starts it from a different edge than the cockpit's.
            "pl-[max(12px,calc(var(--titlebar-inset)+4px))]",
            // The band the rail and the masthead draw, so all three read as one
            // row across the window.
            "md:h-[var(--titlebar-band-height)]",
          )}
        >
          <span className="px-1.5 font-heading text-lg font-semibold tracking-tight text-foreground">Telar</span>
        </div>
        <div className="px-1 pt-1">
          <div className="px-1">
            <h2 className="font-heading text-sm font-semibold tracking-tight text-foreground">
              {title}
            </h2>
            {subtitle && (
              <div className="mt-0.5 text-xs text-muted-foreground">{subtitle}</div>
            )}
          </div>
        </div>
        {/* THE FIELD STANDS WHERE THE PANE LIST STARTS, and the results take
            the list's place while there is a query — see settings-search-nav.tsx
            for why this is not an overlay. A shell with no index (project
            settings) renders exactly the nav it always had. */}
        {search ? (
          <SettingsSearchNav index={search} onChoose={jumpTo}>
            {paneList}
          </SettingsSearchNav>
        ) : (
          paneList
        )}
        {/* THE ROAD OUT, AT THE FLOOR. The app rail keeps Settings in its
            footer; this nav keeps the way back in the same slot — the inverse
            door, where the hand already knows to look. Top of the nav is
            window decoration and carries no navigation at all. */}
        {backHref && (
          <div className="mt-auto shrink-0 pt-2">
            <Link
              href={backHref}
              className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              <ArrowLeftIcon className="size-4 shrink-0 text-muted-foreground/70" />
              <span className="flex-1 truncate">Back</span>
            </Link>
          </div>
        )}
      </nav>
      <button
        type="button"
        aria-label="Resize settings sidebar"
        title="Drag to resize settings sidebar"
        onPointerDown={(event) => {
          event.preventDefault();
          setDragWidth(navWidth);
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
        className="app-no-drag -mx-2 hidden w-4 shrink-0 cursor-col-resize items-stretch justify-center md:flex"
      >
        <span className="my-3 w-px rounded bg-sidebar-border/40" />
      </button>

      {/* Content pane — sticky header + internal scroll. On `md` it is the
          second island: the conversation card's recipe from the cockpit
          (`bg-sidebar`, hairline ring, the inset's radius), clipping its own
          content so the sticky header keeps the rounded corners. */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden md:rounded-xl md:bg-sidebar md:shadow-sm md:ring-1 md:ring-sidebar-border">
        {/* Drag region: the top of the window on the macOS shell. */}
        {/* EXACTLY the titlebar height, as the app header is — `min-h` plus
            padding let this bar settle a few pixels off the one it replaces,
            and the seam jumped on every trip into Settings. On `md` it is 16px
            shorter, as every header beside the rail is (page-header.tsx). */}
        {/* `app-ground`: this sticky bar is a ground — over a backdrop it goes
            glass with the wash instead of keeping an 80% fill (class-name
            matching died with Phase 2; grounds opt in). */}
        <header className="app-drag app-ground sticky top-0 z-10 flex h-[var(--titlebar-height)] shrink-0 items-center gap-2.5 border-b border-border bg-background/65 px-5 text-foreground backdrop-blur md:h-[var(--titlebar-band-height)]">
          {/*
            A CRUMB, NOT A TITLE. The pane's name alone repeated what the
            selected nav row already said and named no place to go back to;
            `Settings / Projects` states where this pane sits, which is the one
            thing the nav cannot say about itself once it has scrolled. The
            icon is gone with it — it was the third copy of the same glyph, in
            a bar 16px tall.

            NOT LINKS. Both segments are where the reader already is: the shell
            IS Settings, and the pane is the one selected. `aria-current` says
            so rather than offering a crumb that navigates nowhere.
          */}
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-sm text-muted-foreground">{title}</span>
            <span aria-hidden className="shrink-0 text-sm text-muted-foreground/50">
              /
            </span>
            <h3 aria-current="page" className="truncate font-heading text-sm font-semibold tracking-tight">
              {activeSection.label}
            </h3>
          </nav>
          <div className="app-no-drag ml-auto flex items-center gap-2">
            {headerActions}
            {/* PAGE-SCOPED, and present only where a section offered one — see
                `useRestoreDefaults`. Ghost, because it undoes rather than
                does: the filled weight belongs to whatever a pane's own
                primary action is. */}
            {restorers.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => {
                  for (const restore of restorers) void restore();
                }}
              >
                <Undo2Icon className="size-3.5" />
                Restore defaults
              </Button>
            )}
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className={cn("mx-auto w-full px-5 py-5", wide ? "max-w-[1400px]" : "max-w-2xl")}>
            <SettingsPaneContext.Provider value={activeSection.id}>
              <SettingsRestoreContext.Provider value={restoreRegistry}>{children}</SettingsRestoreContext.Provider>
            </SettingsPaneContext.Provider>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A TITLED BLOCK OF FIELDS — ONE RAISED CARD, WITH THE TITLE AS A CAPTION ABOVE IT.
 *
 * It was hairlines and space with no card, on the reasoning that a card inside
 * a `Panel` is a card inside a card. That reasoning does not apply here: this
 * shell is a FULL-PAGE TAKEOVER — it replaces the app rail rather than standing
 * inside a panelled surface (see `SettingsShell`) — so there is no outer card
 * for this one to nest in, and the pane the reference draws is the one this
 * follows now (`docs/design/t3code-survey/03-settings-landing.png`).
 *
 * WHY THE CARD EARNS ITS KEEP. Without it a pane of five groups is one column
 * of hairlines, and the only thing saying where a group ends is a heading a
 * reader has to scan back up to. The card states the boundary structurally:
 * every row inside it is governed by the caption above it, and the gap between
 * cards is the group break. That is the whole reason the reference reads as
 * grouped and the hairline version read as a list.
 *
 * THE CAPTION RECEDES AND THE ROWS LEAD. It was `text-base font-semibold`, one
 * step LARGER than the row titles beneath it, which made the section name the
 * loudest thing on a page whose content is the rows. Small, normal weight and
 * `text-foreground/70` is the reference's own grammar, and it inverts the
 * emphasis the right way round.
 *
 * `action` is the control that belongs to the whole group rather than to any
 * one field — an "Advanced" switch, a reset. It sits on the caption line,
 * outside the card, because it acts on the group rather than on any row in it.
 */
export function SettingsGroup({
  title,
  description,
  action,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-6 last:mb-0">
      {(title || description || action) && (
        // `px-4` matches the card's own row padding, so the caption sits over
        // the row titles rather than over the card's edge.
        <div className="mb-2 flex items-start gap-3 px-4">
          <div className="min-w-0 flex-1">
            {title && <h4 className="font-heading text-[0.8125rem] font-normal tracking-tight text-foreground/70">{title}</h4>}
            {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {/* THE ROWS OWN NO HORIZONTAL PADDING OF THEIR OWN — `Row` also lives in
          a Panel and in the session's narrow column, where the surface supplies
          it. The card supplies it here, to its direct children, so a caller
          that puts something other than a Row inside a group still lines up.
          Vertical padding stays even at both ends: inside a card, an eaten
          first-row `pt` presses the text against the border. */}
      <div className="divide-y divide-border/60 rounded-xl border border-border bg-card shadow-sm [&>*]:px-4">
        {/* Only a plain-string title names a group for the rows beneath it. A
            title spliced from a value ("Telar's servers") would put the project
            name into every anchor under it, so those rows fall back to the
            pane-and-label id rather than to an anchor that moves with data. */}
        <SettingsGroupContext.Provider value={typeof title === "string" ? title : undefined}>{children}</SettingsGroupContext.Provider>
      </div>
    </section>
  );
}

/**
 * ONE FIELD: what it is, what it does, and the control that changes it.
 *
 * THE DESCRIPTION IS PART OF THE FIELD, not a footnote. A settings page that
 * explains itself in a paragraph above the controls makes the reader hold the
 * paragraph in their head while they look for the switch; a sentence sitting
 * under its own label is read at the moment it is needed and ignored the rest
 * of the time. That is the whole reason `hint` survived the copy cull.
 *
 * `onRevert` appears only when the value is not the default — an affordance
 * that costs nothing when there is nothing to undo, and saves a reader who
 * changed something an hour ago from having to remember what it was.
 *
 * THE REVERT SLOT IS RESERVED WHETHER OR NOT IT HOLDS ANYTHING. The arrow comes
 * and goes with the value, and rendered conditionally into the middle of the
 * label line it re-laid out the row under the pointer — you changed a setting
 * and the label you had just read moved sideways. The slot now sits at the END
 * of the label line and is always present: empty it is invisible trailing
 * space, and filled it pushes nothing.
 *
 * `status` IS THE ROW'S STATE, NOT ITS VALUE. "Not connected", "Beta", "Failed
 * to start" — a word about the row itself, which is why it reads beside the
 * label rather than inside `control`, where it would be mistaken for the thing
 * you are meant to press. The value stays in `control`; the explanation stays
 * in `hint`.
 *
 * `error` IS WHAT HAPPENED TO THE LAST WRITE, and it is a slot of its own
 * rather than a sentence swapped into `hint`.
 *
 * Every row here saves on change, through an engine that can be unreachable —
 * so "it refused" is a state a row has to be able to be in, and the shape of
 * the failure is specific: THE VALUE DID NOT MOVE. The hooks behind these rows
 * only ever advance their state on the engine's own answer, so a refused write
 * leaves the control showing what is actually stored. What was missing was the
 * saying so. Swapping the error INTO `hint` was the old workaround and it costs
 * the explanation: a reader who has just been refused loses the sentence that
 * would tell them what the setting does, at the moment they are most likely to
 * want it. The error reads under the hint, in the destructive colour, and the
 * hint stays put.
 *
 * `unavailable` IS THE THIRD STATE A SETTING CAN BE IN: not on, not off, not
 * applicable — the plugin failed to start, this build has no desktop shell. The
 * control stays VISIBLE and goes inert, because a row that silently vanished
 * teaches the reader nothing and a row whose control is live teaches them the
 * app is broken; the reason takes the hint slot, which is where they are
 * already looking when a control does not answer.
 *
 * THE CONTROL COLUMN NEVER SQUEEZES THE LABEL. Both sides declare their own
 * width and the row wraps on a narrow pane rather than compressing the label
 * into a ribbon of one word per line — which is exactly what happened when a
 * caller handed `control` three buttons.
 *
 * EVERY ROW IS A DESTINATION. It carries an id and takes focus programmatically
 * (`tabIndex={-1}`, which keeps it out of the tab order for everyone who did
 * not ask to go there) so settings search can scroll to it, focus it and pulse
 * it once. The id is derived from the pane and group around it — see
 * `settingsRowId` — so it exists without anybody maintaining a table of them.
 * `id` is for the rows the derivation cannot serve: a label that is a component
 * or carries a value, where the slug would be unstable or absent.
 */
export function Row({
  id,
  label,
  hint,
  icon: Icon,
  status,
  control,
  onRevert,
  error,
  unavailable,
  children,
}: {
  /** Overrides the derived anchor. Needed only when `label` is not a string. */
  id?: string;
  label: ReactNode;
  hint?: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  /** A word for the row's own state, beside the label — not its value. */
  status?: ReactNode;
  control?: ReactNode;
  /** Shown as a revert arrow at the end of the label line; omit when the value is default. */
  onRevert?: () => void;
  /** Why the last write did not land. Reads UNDER the hint, never instead of it. */
  error?: ReactNode;
  /** Renders `control` inert and puts `reason` where the hint would be. */
  unavailable?: { reason: ReactNode };
  children?: ReactNode;
}) {
  const page = useContext(SettingsPaneContext);
  const group = useContext(SettingsGroupContext);
  const anchor =
    id ??
    (typeof label === "string"
      ? settingsRowId({ ...(page ? { page } : {}), ...(group ? { group } : {}), label })
      : undefined);
  // The reason REPLACES the hint rather than joining it: a sentence about how
  // the setting behaves, printed under the sentence saying it does not apply
  // here, is one sentence the reader has to work out is moot.
  const explanation = unavailable ? unavailable.reason : hint;

  return (
    <div
      {...(anchor ? { id: anchor } : {})}
      // Focusable only on purpose: -1 answers `.focus()` and stays out of the
      // tab order, so arriving from a search result lands the caret on the row
      // while tabbing through the pane still goes control to control.
      tabIndex={-1}
      className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3 outline-none">
      <div className="flex min-w-48 flex-1 items-start gap-2.5">
        {Icon && (
          <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground/70">
            <Icon className="size-4" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium text-foreground">{label}</span>
            {status && <span className="shrink-0">{status}</span>}
            {/* The reserved slot — `size-3` is the arrow's own box, so the row
                measures the same with it and without it. */}
            <span className="flex size-3 shrink-0 items-center justify-center">
              {onRevert && (
                <button
                  type="button"
                  title="Back to the default"
                  aria-label="Revert to the default"
                  onClick={onRevert}
                  className="text-muted-foreground/60 transition-colors hover:text-foreground"
                >
                  <Undo2Icon className="size-3" />
                </button>
              )}
            </span>
          </div>
          {explanation && <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{explanation}</p>}
          {/* `alert`, not `status`: the control still shows the stored value,
              so nothing on screen changed when the write was refused — a
              screen reader would otherwise be told nothing at all. */}
          {error && (
            <p role="alert" className="mt-1 flex items-start gap-1.5 text-xs leading-snug text-destructive">
              <CircleAlertIcon className="mt-px size-3 shrink-0" />
              <span>{error}</span>
            </p>
          )}
          {children}
        </div>
      </div>
      {control && (
        // `inert` is what makes an ARBITRARY control inert. This slot holds
        // switches, buttons, selects and whole forms, and Row cannot reach into
        // any of them to pass a `disabled` — one attribute takes the lot out of
        // the tab order and out of the accessibility tree. The reason stays
        // OUTSIDE it, where a screen reader still reaches it.
        <div
          inert={unavailable ? true : undefined}
          className={cn("flex shrink-0 items-center justify-end", unavailable && "opacity-50")}
        >
          {control}
        </div>
      )}
    </div>
  );
}

/**
 * A SEGMENTED CHOICE, WITHOUT THE PILL.
 *
 * It was a filled track with a raised, ringed, shadowed thumb — a control with
 * more chrome than anything it sits beside, and at four or five options it read
 * as a row of chunky buttons rather than as one field's value. Now it is a
 * hairline group whose selected segment is a quiet fill: the same information,
 * at the weight of the rest of the page.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
}) {
  return (
    <div className="inline-flex items-center rounded-md border border-border">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 text-xs transition-colors first:rounded-l-[5px] last:rounded-r-[5px] not-first:border-l not-first:border-border",
              on ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * TABS FOR A PANE THAT HAS MODES — an underline, not a pill.
 *
 * The appearance studio's five tools were a Segmented, which made the pane's
 * primary navigation look like one of its fields. An underlined row is the
 * idiom every settings surface uses for this, and it reads as "these are
 * places" rather than "this is a value".
 */
export function Tabs<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
}) {
  return (
    <div role="tablist" className="flex items-center gap-4 border-b border-border">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "-mb-px flex items-center gap-1.5 border-b-2 px-0.5 pb-2 text-sm transition-colors",
              on ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// Labelled toggle row. `status`, `error`, `onRevert` and `unavailable` pass
// straight through: a toggle is a Row, it is off its default as often as any
// other field, and a switch that does not apply here is the commonest case
// `unavailable` exists for.
export function ToggleRow({
  id,
  label,
  hint,
  icon,
  status,
  checked,
  onCheckedChange,
  onRevert,
  error,
  unavailable,
}: {
  /** Passed straight through — a toggle row is a Row, and is a search destination like any other. */
  id?: string;
  label: ReactNode;
  hint?: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  status?: ReactNode;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  onRevert?: () => void;
  error?: ReactNode;
  unavailable?: { reason: ReactNode };
}) {
  return (
    <Row
      {...(id ? { id } : {})}
      label={label}
      hint={hint}
      icon={icon}
      {...(status ? { status } : {})}
      {...(onRevert ? { onRevert } : {})}
      {...(error ? { error } : {})}
      {...(unavailable ? { unavailable } : {})}
      control={<Switch checked={checked} onCheckedChange={onCheckedChange} />}
    />
  );
}

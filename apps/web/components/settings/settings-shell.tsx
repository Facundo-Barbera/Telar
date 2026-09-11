"use client";

// Shared settings frame — ported verbatim from the frozen app's
// components/settings/settings-shell.tsx. A fixed side-nav (never scrolls) and
// an internally-scrolling content pane with a sticky sub-header. Colors come
// from theme tokens only; nothing hard-codes a palette.
import { createContext, useContext, useEffect, useRef, useState, type ComponentType, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeftIcon, Undo2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import { settingsRowId } from "@/lib/settings-search";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
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

export function SettingsShell({
  title,
  subtitle,
  sections,
  active,
  onSelect,
  backHref,
  dirty,
  saving,
  onSave,
  headerActions,
  wide,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  sections: SettingsSection[];
  active: string;
  onSelect: (id: string) => void;
  backHref?: string;
  dirty?: boolean;
  saving?: boolean;
  onSave?: () => void;
  headerActions?: ReactNode;
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
  const ActiveIcon = activeSection.icon;
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

  // Group the nav if any section declares a group; otherwise flat.
  const groups = sections.some((s) => s.group)
    ? Array.from(new Set(sections.map((s) => s.group ?? ""))).map((g) => ({
        group: g,
        items: sections.filter((s) => (s.group ?? "") === g),
      }))
    : [{ group: "", items: sections }];

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
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          {groups.map(({ group, items }) => (
            <div key={group} className="flex flex-col gap-0.5">
              {group && (
                <div className="px-2 pb-1 text-[0.625rem] font-medium uppercase tracking-wider text-muted-foreground/60">
                  {group}
                </div>
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
                      on
                        ? "bg-muted font-medium text-foreground"
                        : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                    )}
                  >
                    <Icon
                      className={cn(
                        "size-4 shrink-0",
                        on ? "text-foreground" : "text-muted-foreground/70",
                      )}
                    />
                    <span className="flex-1 truncate">{s.label}</span>
                    {s.count != null && (
                      <span className="text-[0.6875rem] tabular-nums text-muted-foreground/60">
                        {s.count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
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
          <ActiveIcon className="size-4 text-muted-foreground" />
          <h3 className="font-heading text-sm font-semibold tracking-tight">
            {activeSection.label}
          </h3>
          <div className="app-no-drag ml-auto flex items-center gap-2">
            {headerActions}
            {onSave && (
              <>
                {dirty && (
                  <Badge variant="outline" className="gap-1.5 text-[0.625rem]">
                    {/* --warning, where the donor reached for a raw Tailwind
                        ramp. This app holds every state colour on the five-token
                        vocabulary so a dot and a badge cannot disagree about
                        what the colour means (see app/globals.test.ts). */}
                    <span className="size-1.5 rounded-full bg-warning" />
                    Unsaved
                  </Badge>
                )}
                <Button
                  size="sm"
                  variant={dirty ? "default" : "outline"}
                  disabled={!dirty || saving}
                  onClick={onSave}
                >
                  {saving && <Spinner />}
                  Save changes
                </Button>
              </>
            )}
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className={cn("mx-auto w-full px-5 py-5", wide ? "max-w-[1400px]" : "max-w-2xl")}>
            <SettingsPaneContext.Provider value={activeSection.id}>{children}</SettingsPaneContext.Provider>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A TITLED BLOCK OF FIELDS — and, since this rebuild, NOT A CARD.
 *
 * It used to wrap its rows in `rounded-xl bg-card ring-1`, which put every
 * setting inside a raised slab. Two costs: on a pane that already frames
 * regions with `Panel` (components/ui/panel.tsx) it was a card inside a card,
 * and on its own it made a list of decisions read as an object to be handled
 * rather than a page to be read. The reference this pane now follows separates
 * fields with SPACE and a hairline, and lets the title carry the structure.
 *
 * `action` is the control that belongs to the whole group rather than to any
 * one field — an "Advanced" switch, a reset.
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
    <section className="mb-7 last:mb-0">
      {(title || description || action) && (
        <div className="mb-2.5 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {/* A GROUP TITLE READS AS A SECTION, not as a row label: one step
                larger than the rows beneath it, so a page of several groups
                scans as several groups rather than one long list. */}
            {title && <h4 className="font-heading text-base font-semibold tracking-tight text-foreground">{title}</h4>}
            {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {/* The group owns the tightening at its ends: its own title supplies the
          space above the first field, and the next group supplies it below the
          last. A Row cannot know that — it also lives inside Panels, where
          eating its own padding pressed the text against the border. */}
      <div className="divide-y divide-border/60 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
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

// Labelled toggle row. `status` and `unavailable` pass straight through: a
// toggle is a Row, and a switch that does not apply here is the commonest case
// `unavailable` exists for.
export function ToggleRow({
  id,
  label,
  hint,
  icon,
  status,
  checked,
  onCheckedChange,
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
  unavailable?: { reason: ReactNode };
}) {
  return (
    <Row
      {...(id ? { id } : {})}
      label={label}
      hint={hint}
      icon={icon}
      {...(status ? { status } : {})}
      {...(unavailable ? { unavailable } : {})}
      control={<Switch checked={checked} onCheckedChange={onCheckedChange} />}
    />
  );
}

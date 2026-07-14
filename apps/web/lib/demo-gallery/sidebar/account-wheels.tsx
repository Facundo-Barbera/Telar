"use client";

// The plan-usage account wheels, redesigned: compact by DEFAULT (a tight row of
// just the rings) and grab-and-drop reorderable. Mirrors the production
// AppSidebar's per-account PlanRing visuals (outer ring = 5h session, inner =
// weekly; tone shifts amber→red as utilization climbs) but adds two things the
// user asked for:
//   1. reorder — drag a wheel to choose display order (HTML5 drag events only,
//      no new deps). A subtle grip appears on hover; a primary insertion bar
//      marks the drop point while dragging.
//   2. compact by default — only the wheels show until you expand the chevron,
//      which reveals the fuller per-account detail. Reorder works in either
//      mode, and in the collapsed icon rail.
// Order lives in component state — a fixture demo. When this ships, the chosen
// order becomes a settings FACT (persisted per user), not engine behavior.
// Token classes only (no `dark:`) so the lane's ThemeSurface controls the look.
import { useState } from "react";
import {
  ChevronDownIcon,
  GripVerticalIcon,
  RefreshCwIcon,
} from "lucide-react";
import { ACCOUNTS, type DemoAccount } from "./fixtures";

// ── ring visuals (mirror production PlanRing) ──────────────────────────────

function ringTone(p: number): string {
  if (p >= 90) return "stroke-destructive";
  if (p >= 70) return "stroke-amber-500";
  return "stroke-primary";
}

// One account's wheel: outer ring = 5h, inner ring = weekly.
function AccountWheel({ five, week }: { five: number; week: number }) {
  const size = 30,
    cxy = 15,
    sw = 3;
  const ring = (r: number, p: number) => {
    const circ = 2 * Math.PI * r;
    return (
      <>
        <circle
          cx={cxy}
          cy={cxy}
          r={r}
          fill="none"
          strokeWidth={sw}
          className="stroke-sidebar-foreground/10"
        />
        <circle
          cx={cxy}
          cy={cxy}
          r={r}
          fill="none"
          strokeWidth={sw}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - Math.min(100, p) / 100)}
          className={ringTone(p)}
        />
      </>
    );
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="-rotate-90 shrink-0"
      aria-hidden
    >
      {ring(12, five)}
      {ring(7, week)}
    </svg>
  );
}

// ── reorder plumbing (HTML5 drag) ──────────────────────────────────────────

function moveByName(order: string[], from: string, to: string): string[] {
  if (from === to) return order;
  const next = order.filter((n) => n !== from);
  const at = next.indexOf(to);
  if (at === -1) return order;
  next.splice(at, 0, from);
  return next;
}

type DragState = {
  drag: string | null; // account being dragged
  over: string | null; // account the cursor is over (insertion target)
};

// Shared drag props for a draggable wheel/row. `axis` picks the insertion-bar
// orientation so the same handlers work in the horizontal strip and the
// vertical expanded list / collapsed rail.
function useDrag(
  order: string[],
  setOrder: (o: string[]) => void,
): [
  DragState,
  (name: string) => {
    draggable: true;
    onDragStart: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
    onDragEnd: () => void;
  },
] {
  const [state, setState] = useState<DragState>({ drag: null, over: null });
  const bind = (name: string) => ({
    draggable: true as const,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", name);
      setState({ drag: name, over: name });
    },
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setState((s) => (s.over === name ? s : { ...s, over: name }));
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      if (state.drag) setOrder(moveByName(order, state.drag, name));
      setState({ drag: null, over: null });
    },
    onDragEnd: () => setState({ drag: null, over: null }),
  });
  return [state, bind];
}

// Primary insertion bar shown just before the drop target while dragging.
function DropBar({ axis, show }: { axis: "x" | "y"; show: boolean }) {
  return (
    <span
      aria-hidden
      className={`shrink-0 rounded-full bg-primary transition-opacity ${
        axis === "x" ? "my-1 w-0.5 self-stretch" : "mx-1 h-0.5 self-stretch"
      } ${show ? "opacity-100" : "opacity-0"}`}
    />
  );
}

// ── compact strip: just the wheels, tight horizontal row ───────────────────

function CompactStrip({
  order,
  setOrder,
  onExpand,
}: {
  order: string[];
  setOrder: (o: string[]) => void;
  onExpand: () => void;
}) {
  const [drag, bind] = useDrag(order, setOrder);
  const byName = (n: string) => ACCOUNTS.find((a) => a.name === n)!;
  return (
    <div className="flex items-center gap-1 px-1">
      <div className="flex flex-1 items-center gap-1">
        {order.map((name) => {
          const a = byName(name);
          const dragging = drag.drag === name;
          const showBar = drag.drag != null && drag.over === name && !dragging;
          return (
            <div key={name} className="flex items-center">
              <DropBar axis="x" show={showBar} />
              <div
                {...bind(name)}
                title={`${a.name} — drag to reorder`}
                className={`group/wheel relative cursor-grab rounded-full p-0.5 transition active:cursor-grabbing hover:-translate-y-0.5 hover:bg-sidebar-accent ${
                  dragging ? "opacity-40" : ""
                }`}
              >
                <AccountWheel five={a.fiveHour} week={a.weekly} />
                {/* subtle grab affordance on hover */}
                <GripVerticalIcon className="pointer-events-none absolute -top-0.5 left-1/2 size-3 -translate-x-1/2 text-sidebar-foreground/50 opacity-0 transition-opacity group-hover/wheel:opacity-100" />
              </div>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={onExpand}
        aria-label="Expand plan usage"
        title="Show per-account detail"
        className="flex size-6 shrink-0 items-center justify-center rounded text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground"
      >
        <ChevronDownIcon className="size-3.5 -rotate-90" />
      </button>
    </div>
  );
}

// ── expanded list: per-account detail rows ─────────────────────────────────

function ExpandedRow({
  account,
  dragging,
  showBar,
  bind,
}: {
  account: DemoAccount;
  dragging: boolean;
  showBar: boolean;
  bind: ReturnType<ReturnType<typeof useDrag>[1]>;
}) {
  return (
    <div className="flex flex-col">
      <DropBar axis="y" show={showBar} />
      <div
        {...bind}
        title="Drag to reorder"
        className={`group/row flex cursor-grab items-center gap-2 rounded-md px-1 py-1 transition active:cursor-grabbing hover:bg-sidebar-accent ${
          dragging ? "opacity-40" : ""
        }`}
      >
        <GripVerticalIcon className="size-3.5 shrink-0 text-sidebar-foreground/30 transition-colors group-hover/row:text-sidebar-foreground/60" />
        <AccountWheel five={account.fiveHour} week={account.weekly} />
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-mono text-xs text-sidebar-foreground/70">
              {account.name}
            </span>
            <span className="shrink-0 rounded bg-sidebar-accent px-1 font-mono text-[9px] uppercase text-sidebar-accent-foreground">
              {account.subscription}
            </span>
            {account.tier && (
              <span className="shrink-0 font-mono text-[9px] text-sidebar-foreground/50">
                {account.tier}
              </span>
            )}
          </span>
          <span className="font-mono text-[10px] text-sidebar-foreground/45">
            {account.fiveHour}% · 5h &nbsp; {account.weekly}% · wk
          </span>
        </div>
      </div>
    </div>
  );
}

function ExpandedList({
  order,
  setOrder,
  onCollapse,
}: {
  order: string[];
  setOrder: (o: string[]) => void;
  onCollapse: () => void;
}) {
  const [drag, bind] = useDrag(order, setOrder);
  const byName = (n: string) => ACCOUNTS.find((a) => a.name === n)!;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-medium text-sidebar-foreground/60">
          Plan usage
        </span>
        <div className="flex items-center">
          <button
            type="button"
            aria-label="Refresh"
            title="Refresh plan usage"
            className="flex size-6 items-center justify-center rounded text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <RefreshCwIcon className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Collapse plan usage"
            title="Collapse to wheels"
            className="flex size-6 items-center justify-center rounded text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <ChevronDownIcon className="size-3.5 rotate-180" />
          </button>
        </div>
      </div>
      <div>
        {order.map((name) => (
          <ExpandedRow
            key={name}
            account={byName(name)}
            dragging={drag.drag === name}
            showBar={drag.drag != null && drag.over === name && drag.drag !== name}
            bind={bind(name)}
          />
        ))}
      </div>
    </div>
  );
}

// ── collapsed icon rail: wheels stacked, still reorderable ─────────────────

function RailWheels({
  order,
  setOrder,
}: {
  order: string[];
  setOrder: (o: string[]) => void;
}) {
  const [drag, bind] = useDrag(order, setOrder);
  const byName = (n: string) => ACCOUNTS.find((a) => a.name === n)!;
  return (
    <div className="flex flex-col items-center">
      {order.map((name) => {
        const a = byName(name);
        const dragging = drag.drag === name;
        return (
          <div key={name} className="flex w-full flex-col items-center">
            <DropBar axis="y" show={drag.drag != null && drag.over === name && !dragging} />
            <div
              {...bind(name)}
              title={`${a.name} — drag to reorder`}
              className={`cursor-grab rounded-full p-0.5 transition active:cursor-grabbing hover:bg-sidebar-accent ${
                dragging ? "opacity-40" : ""
              }`}
            >
              <AccountWheel five={a.fiveHour} week={a.weekly} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── public component ───────────────────────────────────────────────────────

export function AccountWheels({
  collapsed = false,
  startExpanded = false,
}: {
  collapsed?: boolean;
  startExpanded?: boolean;
}) {
  const [order, setOrder] = useState<string[]>(ACCOUNTS.map((a) => a.name));
  const [expanded, setExpanded] = useState(startExpanded);

  if (collapsed) {
    return <RailWheels order={order} setOrder={setOrder} />;
  }
  return expanded ? (
    <ExpandedList order={order} setOrder={setOrder} onCollapse={() => setExpanded(false)} />
  ) : (
    <CompactStrip order={order} setOrder={setOrder} onExpand={() => setExpanded(true)} />
  );
}

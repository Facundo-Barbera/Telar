"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ActivityIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderGit2Icon,
  GripVerticalIcon,
  LayoutDashboardIcon,
  MessageSquareIcon,
  PinIcon,
  PinOffIcon,
  RefreshCwIcon,
  SettingsIcon,
} from "lucide-react";
import type { Loom, WorkUnitState } from "@telar/core";
import { useAccounts } from "@/lib/use-accounts";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { StateBadge } from "@/components/common/state-badge";
import { isTerminal } from "@/components/looms/utils";

// Auto-refresh plan usage on mount when a snapshot is missing or older than
// this — keeps the sidebar honest without a manual click.
const PLAN_STALE_MS = 30 * 60 * 1000;
// How many non-pinned recent projects to surface (active-first, then recency).
const RECENTS_LIMIT = 6;
// localStorage keys — the only UI-prefs persistence in the app (no server store
// exists yet, per recon). Reads are hydration-guarded (see useStoredList).
const PINNED_KEY = "telar:pinned-projects";
const WHEEL_ORDER_KEY = "telar:account-wheel-order";

type PlanWindow = { utilization: number | null; resets_at: string | null };

type PlanSnapshot = {
  capturedAt: number;
  subscriptionType: string | null;
  fiveHour?: PlanWindow | null;
  sevenDay?: PlanWindow | null;
  sevenDayOpus?: PlanWindow | null;
  sevenDaySonnet?: PlanWindow | null;
  modelScoped?: {
    display_name: string;
    utilization: number | null;
    resets_at: string | null;
  }[];
};

type UsageWindow = {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
};

// Chats feed the nested "today" list under each project (title + recency) and
// per-project recency ordering. Declared locally so this client bundle never
// pulls in the fs-backed store.
type ChatMeta = { id: string; title: string; project?: string; updatedAt: number };
type ProjectMeta = { entry: { name: string; addedAt: number } };

// A project row's derived shape: recency for ordering, an active flag (a loom
// in flight), and today's nested children (active looms + today's chats).
type SidebarProject = {
  name: string;
  recency: number;
  active: boolean;
  looms: Loom[];
  todayChats: ChatMeta[];
};

// ── localStorage-backed ordered list (hydration-safe) ──────────────────────
// First render always yields `null` (server + first client paint agree), then
// an effect reads the stored value — so no SSR hydration mismatch. Writers
// persist synchronously.
function useStoredList(
  key: string,
): [string[] | null, (v: string[]) => void] {
  const [value, setValue] = useState<string[] | null>(null);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      setValue(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      setValue([]);
    }
  }, [key]);
  const set = useCallback(
    (v: string[]) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        // best-effort — a private-mode block just means order isn't remembered
      }
    },
    [key],
  );
  return [value, set];
}

// Keep a stored order aligned with the live set: drop names that vanished,
// append newcomers in their canonical order at the end.
function reconcile(stored: string[], actual: string[]): string[] {
  const kept = stored.filter((n) => actual.includes(n));
  const added = actual.filter((n) => !kept.includes(n));
  return [...kept, ...added];
}

function fmtReset(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

// Compact relative label for nested chat rows ("now" / "3m" / "5h" / "2d").
function fmtShort(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function isToday(ts: number): boolean {
  return new Date(ts).toDateString() === new Date().toDateString();
}

function ringTone(p: number | null): string {
  if (p == null) return "stroke-sidebar-foreground/20";
  if (p >= 90) return "stroke-destructive";
  if (p >= 70) return "stroke-amber-500";
  return "stroke-primary";
}

function dotClass(p: number | null): string {
  if (p == null) return "bg-sidebar-foreground/20";
  if (p >= 90) return "bg-destructive";
  if (p >= 70) return "bg-amber-500";
  return "bg-primary";
}

// ── plan-usage wheel (production PlanRing visuals, kept exact) ──────────────
// Outer ring = 5h session, inner ring = weekly. Null windows draw only the
// faint track (no arc) — the app renders before the first probe lands.
function AccountWheel({
  five,
  week,
}: {
  five: number | null;
  week: number | null;
}) {
  const size = 30,
    cxy = size / 2,
    sw = 3,
    rOut = 12,
    rIn = 7;
  const circ = (r: number) => 2 * Math.PI * r;
  const off = (r: number, p: number | null) =>
    circ(r) * (1 - Math.min(100, p ?? 0) / 100);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="-rotate-90 shrink-0"
      aria-hidden
    >
      <circle cx={cxy} cy={cxy} r={rOut} fill="none" strokeWidth={sw} className="stroke-sidebar-foreground/10" />
      <circle cx={cxy} cy={cxy} r={rIn} fill="none" strokeWidth={sw} className="stroke-sidebar-foreground/10" />
      {five != null && (
        <circle
          cx={cxy}
          cy={cxy}
          r={rOut}
          fill="none"
          strokeWidth={sw}
          strokeLinecap="round"
          strokeDasharray={circ(rOut)}
          strokeDashoffset={off(rOut, five)}
          className={ringTone(five)}
        />
      )}
      {week != null && (
        <circle
          cx={cxy}
          cy={cxy}
          r={rIn}
          fill="none"
          strokeWidth={sw}
          strokeLinecap="round"
          strokeDasharray={circ(rIn)}
          strokeDashoffset={off(rIn, week)}
          className={ringTone(week)}
        />
      )}
    </svg>
  );
}

// ── per-wheel hover tip (fixed-position, collision-aware) ───────────────────
// Restores the detail the production Radix PlanRing tooltip showed (account ·
// plan · tier, then every real usage window with a tone dot + mini bar + pct),
// but as an anchored, out-of-flow overlay that ESCAPES the fixed sidebar clip
// and coexists with drag: pointer-events off, held shut while dragging, and
// never a transform on any ancestor (that would capture the position:fixed).

// One usage window inside the tip: tone dot · label · mini bar · pct · reset.
function TipStat({
  label,
  window,
}: {
  label: string;
  window: PlanWindow | { utilization: number | null; resets_at: string | null };
}) {
  const pct = window.utilization;
  return (
    <div className="flex items-center gap-3">
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        <span className={`size-1.5 shrink-0 rounded-full ${dotClass(pct)}`} />
        {label}
      </span>
      <span className="ml-auto flex items-center gap-1.5">
        <span className="h-1 w-10 overflow-hidden rounded-full bg-muted-foreground/20">
          <span
            className={`block h-full rounded-full ${dotClass(pct)}`}
            style={{ width: `${Math.min(100, pct ?? 0)}%` }}
          />
        </span>
        <span className="w-7 text-right font-mono tabular-nums">
          {pct != null ? `${Math.round(pct)}%` : "—"}
        </span>
      </span>
    </div>
  );
}

// SSR-safe layout effect (the tip only measures client-side).
const useIsoLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

type WheelAccount = {
  name: string;
  subscription: string | null;
  tier?: string;
  five: number | null;
  week: number | null;
  snap: PlanSnapshot;
};

function WheelTip({
  account,
  dragActive,
  side = "top",
  children,
}: {
  account: WheelAccount;
  dragActive: boolean;
  side?: "right" | "top";
  children: React.ReactNode;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  const show = open && !dragActive;

  useIsoLayoutEffect(() => {
    if (!show) {
      setCoords(null);
      return;
    }
    const measure = () => {
      const anchor = anchorRef.current;
      const tip = tipRef.current;
      if (!anchor || !tip) return;
      const a = anchor.getBoundingClientRect();
      const t = tip.getBoundingClientRect();
      const GAP = 8;
      const M = 8;
      let left: number;
      let top: number;
      if (side === "right") {
        left = a.right + GAP;
        if (left + t.width > window.innerWidth - M) left = a.left - t.width - GAP;
        top = a.top + a.height / 2 - t.height / 2;
      } else {
        left = a.left + a.width / 2 - t.width / 2;
        top = a.top - t.height - GAP;
        if (top < M) top = a.bottom + GAP;
      }
      left = Math.min(Math.max(left, M), window.innerWidth - t.width - M);
      top = Math.min(Math.max(top, M), window.innerHeight - t.height - M);
      setCoords({ left, top });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [show, side]);

  const { snap } = account;
  return (
    <span
      ref={anchorRef}
      className="inline-flex shrink-0"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {children}
      {show && (
        <div
          ref={tipRef}
          aria-hidden
          style={{
            position: "fixed",
            left: coords ? coords.left : -9999,
            top: coords ? coords.top : -9999,
          }}
          className={`pointer-events-none z-50 transition-opacity duration-100 ${
            coords ? "opacity-100" : "opacity-0"
          }`}
        >
          <div className="w-max rounded-md border border-border bg-popover px-2.5 py-2 text-popover-foreground shadow-md">
            <div className="mb-1 flex items-center gap-1.5 font-mono text-xs font-medium">
              {account.name}
              {account.subscription && (
                <span className="rounded bg-muted px-1 text-[9px] uppercase text-muted-foreground">
                  {account.subscription}
                </span>
              )}
              {account.tier && (
                <span className="text-[9px] text-muted-foreground">{account.tier}</span>
              )}
            </div>
            <div className="space-y-1 text-[11px] text-muted-foreground">
              {snap.fiveHour && <TipStat label="5-hour session" window={snap.fiveHour} />}
              {snap.sevenDay && <TipStat label="Weekly · all" window={snap.sevenDay} />}
              {snap.sevenDayOpus && <TipStat label="Weekly · Opus" window={snap.sevenDayOpus} />}
              {snap.sevenDaySonnet && <TipStat label="Weekly · Sonnet" window={snap.sevenDaySonnet} />}
              {snap.modelScoped?.map((w) => (
                <TipStat key={w.display_name} label={`Weekly · ${w.display_name}`} window={w} />
              ))}
              {snap.fiveHour?.resets_at && (
                <div className="pt-0.5 font-mono text-[9px] text-muted-foreground/70">
                  resets {fmtReset(snap.fiveHour.resets_at)}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </span>
  );
}

// ── reorder plumbing (HTML5 drag, no new deps) ─────────────────────────────
function moveByName(order: string[], from: string, to: string): string[] {
  if (from === to) return order;
  const next = order.filter((n) => n !== from);
  const at = next.indexOf(to);
  if (at === -1) return order;
  next.splice(at, 0, from);
  return next;
}

type DragState = { drag: string | null; over: string | null };

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
  accounts,
  order,
  setOrder,
  onExpand,
}: {
  accounts: Map<string, WheelAccount>;
  order: string[];
  setOrder: (o: string[]) => void;
  onExpand: () => void;
}) {
  const [drag, bind] = useDrag(order, setOrder);
  return (
    <div className="flex items-center gap-1 px-1">
      <div className="flex flex-1 items-center gap-1">
        {order.map((name) => {
          const a = accounts.get(name);
          if (!a) return null;
          const dragging = drag.drag === name;
          const showBar = drag.drag != null && drag.over === name && !dragging;
          return (
            <div key={name} className="flex items-center">
              <DropBar axis="x" show={showBar} />
              <div
                {...bind(name)}
                aria-label={`${a.name} plan usage — drag to reorder`}
                className={`flex cursor-grab items-center justify-center rounded-full p-0.5 transition active:cursor-grabbing hover:bg-sidebar-accent ${
                  dragging ? "opacity-40" : ""
                }`}
              >
                <WheelTip account={a} dragActive={drag.drag != null} side="top">
                  <AccountWheel five={a.five} week={a.week} />
                </WheelTip>
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
  dragActive,
  showBar,
  bind,
}: {
  account: WheelAccount;
  dragging: boolean;
  dragActive: boolean;
  showBar: boolean;
  bind: ReturnType<ReturnType<typeof useDrag>[1]>;
}) {
  return (
    <div className="flex flex-col">
      <DropBar axis="y" show={showBar} />
      <div
        {...bind}
        aria-label={`${account.name} plan usage — drag to reorder`}
        className={`group/row flex cursor-grab items-center gap-2 rounded-md px-1 py-1 transition active:cursor-grabbing hover:bg-sidebar-accent ${
          dragging ? "opacity-40" : ""
        }`}
      >
        <GripVerticalIcon className="size-3.5 shrink-0 text-sidebar-foreground/30 transition-colors group-hover/row:text-sidebar-foreground/60" />
        <WheelTip account={account} dragActive={dragActive} side="top">
          <AccountWheel five={account.five} week={account.week} />
        </WheelTip>
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-mono text-xs text-sidebar-foreground/70">
              {account.name}
            </span>
            {account.subscription && (
              <span className="shrink-0 rounded bg-sidebar-accent px-1 font-mono text-[9px] uppercase text-sidebar-accent-foreground">
                {account.subscription}
              </span>
            )}
            {account.tier && (
              <span className="shrink-0 font-mono text-[9px] text-sidebar-foreground/50">
                {account.tier}
              </span>
            )}
          </span>
          <span className="font-mono text-[10px] text-sidebar-foreground/45">
            {account.five != null ? `${Math.round(account.five)}%` : "—"} · 5h &nbsp;{" "}
            {account.week != null ? `${Math.round(account.week)}%` : "—"} · wk
          </span>
        </div>
      </div>
    </div>
  );
}

function ExpandedList({
  accounts,
  order,
  setOrder,
  onCollapse,
  onRefresh,
  refreshing,
  ledger,
}: {
  accounts: Map<string, WheelAccount>;
  order: string[];
  setOrder: (o: string[]) => void;
  onCollapse: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  ledger: { session: UsageWindow; weekly: UsageWindow } | null;
}) {
  const [drag, bind] = useDrag(order, setOrder);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-medium text-sidebar-foreground/60">Plan usage</span>
        <div className="flex items-center">
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Refresh plan usage"
            title="Refresh plan usage"
            className="flex size-6 items-center justify-center rounded text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground disabled:opacity-50"
          >
            <RefreshCwIcon className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
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
        {order.map((name) => {
          const a = accounts.get(name);
          if (!a) return null;
          return (
            <ExpandedRow
              key={name}
              account={a}
              dragging={drag.drag === name}
              dragActive={drag.drag != null}
              showBar={drag.drag != null && drag.over === name && drag.drag !== name}
              bind={bind(name)}
            />
          );
        })}
      </div>
      {ledger && (
        <p className="px-1 pt-0.5 font-mono text-[10px] text-sidebar-foreground/40">
          telar-measured: ${ledger.session.costUsd.toFixed(2)} / 5h · $
          {ledger.weekly.costUsd.toFixed(2)} / wk
        </p>
      )}
    </div>
  );
}

// ── collapsed icon rail: wheels stacked, still reorderable ─────────────────
function RailWheels({
  accounts,
  order,
  setOrder,
}: {
  accounts: Map<string, WheelAccount>;
  order: string[];
  setOrder: (o: string[]) => void;
}) {
  const [drag, bind] = useDrag(order, setOrder);
  return (
    <div className="flex flex-col items-center">
      {order.map((name) => {
        const a = accounts.get(name);
        if (!a) return null;
        const dragging = drag.drag === name;
        return (
          <div key={name} className="flex w-full flex-col items-center">
            <DropBar axis="y" show={drag.drag != null && drag.over === name && !dragging} />
            <div
              {...bind(name)}
              aria-label={`${a.name} plan usage — drag to reorder`}
              className={`group/wheel relative flex cursor-grab items-center justify-center rounded-full p-0.5 transition active:cursor-grabbing hover:bg-sidebar-accent ${
                dragging ? "opacity-40" : ""
              }`}
            >
              <WheelTip account={a} dragActive={drag.drag != null} side="right">
                <AccountWheel five={a.five} week={a.week} />
              </WheelTip>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Public: the plan-usage wheels. Compact strip by default; expand to per-account
// detail; a stacked, reorderable rail while the sidebar is collapsed.
function AccountWheels({
  accounts,
  order,
  setOrder,
  collapsed,
  onRefresh,
  refreshing,
  ledger,
}: {
  accounts: Map<string, WheelAccount>;
  order: string[];
  setOrder: (o: string[]) => void;
  collapsed: boolean;
  onRefresh: () => void;
  refreshing: boolean;
  ledger: { session: UsageWindow; weekly: UsageWindow } | null;
}) {
  const [expanded, setExpanded] = useState(false);
  if (order.length === 0) {
    if (collapsed) return null;
    return (
      <p className="px-1 text-xs text-sidebar-foreground/50">
        {refreshing ? "Fetching plan usage…" : "No usage captured yet."}
      </p>
    );
  }
  if (collapsed) {
    return <RailWheels accounts={accounts} order={order} setOrder={setOrder} />;
  }
  return expanded ? (
    <ExpandedList
      accounts={accounts}
      order={order}
      setOrder={setOrder}
      onCollapse={() => setExpanded(false)}
      onRefresh={onRefresh}
      refreshing={refreshing}
      ledger={ledger}
    />
  ) : (
    <CompactStrip
      accounts={accounts}
      order={order}
      setOrder={setOrder}
      onExpand={() => setExpanded(true)}
    />
  );
}

// ── project rows ───────────────────────────────────────────────────────────

// Collapsed-rail glyph: two-letter initials, a pulse if a loom is in flight.
function ProjectGlyph({ name, running }: { name: string; running: boolean }) {
  return (
    <span className="relative flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-[11px] font-semibold uppercase text-sidebar-accent-foreground">
      {name.slice(0, 2)}
      {running && (
        <span className="absolute -right-0.5 -top-0.5 size-2 animate-pulse rounded-full bg-primary ring-2 ring-sidebar" />
      )}
    </span>
  );
}

function RailProject({ project }: { project: SidebarProject }) {
  return (
    <Link
      href={`/projects/${encodeURIComponent(project.name)}`}
      title={project.name}
      className="flex size-8 items-center justify-center rounded-md hover:bg-sidebar-accent"
    >
      <ProjectGlyph name={project.name} running={project.active} />
    </Link>
  );
}

// Expanded project row: expand toggle · project link (pulse if weaving) · pin
// toggle (hover). Expanded, it reveals today's active looms then today's chats.
function ProjectRow({
  project,
  pinned,
  highlighted,
  onTogglePin,
}: {
  project: SidebarProject;
  pinned: boolean;
  highlighted?: boolean;
  onTogglePin: () => void;
}) {
  const pathname = usePathname();
  const href = `/projects/${encodeURIComponent(project.name)}`;
  const nested = project.todayChats.length + project.looms.length;
  const [open, setOpen] = useState(highlighted ?? false);
  const isActive = pathname === href;

  return (
    <div className="group/proj">
      <div
        className={`relative flex items-center rounded-md ${
          highlighted || isActive ? "bg-sidebar-accent/60" : "hover:bg-sidebar-accent"
        }`}
      >
        {(highlighted || isActive) && (
          <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary" />
        )}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          disabled={nested === 0}
          className="flex size-7 items-center justify-center rounded-md text-sidebar-foreground/40 disabled:opacity-0"
          aria-label={open ? "Collapse" : "Expand"}
        >
          <ChevronRightIcon className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
        <Link
          href={href}
          title={project.name}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-left text-sm outline-none"
        >
          <FolderGit2Icon className="size-4 shrink-0 text-sidebar-foreground/70" />
          <span className="truncate">{project.name}</span>
          {project.active && (
            <span className="flex shrink-0 items-center gap-1">
              <span className="size-1.5 animate-pulse rounded-full bg-primary" />
              {project.looms.length > 1 && (
                <span className="font-mono text-[10px] text-sidebar-foreground/50">
                  {project.looms.length}
                </span>
              )}
            </span>
          )}
        </Link>
        <button
          type="button"
          onClick={onTogglePin}
          className="mr-1 flex size-6 items-center justify-center rounded text-sidebar-foreground/40 opacity-0 transition hover:bg-sidebar-accent hover:text-sidebar-foreground group-hover/proj:opacity-100"
          aria-label={pinned ? "Unpin project" : "Pin project"}
          title={pinned ? "Unpin project" : "Pin project"}
        >
          {pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
        </button>
      </div>

      {open && nested > 0 && (
        <div className="ml-[1.375rem] mt-0.5 flex flex-col gap-0.5 border-l border-sidebar-border pl-2">
          {project.looms.map((l) => (
            <Link
              key={l.id}
              href={`/looms/${l.id}`}
              title={l.title}
              className="flex items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-sidebar-accent"
            >
              <StateBadge state={l.state} className="shrink-0 gap-1 px-1.5 py-0 text-[9px]" />
              <span className="truncate text-xs text-sidebar-foreground/80">{l.title}</span>
            </Link>
          ))}
          {project.todayChats.map((c) => (
            <Link
              key={c.id}
              href={`${href}/sessions/${c.id}`}
              title={c.title}
              className="flex items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-sidebar-accent"
            >
              <MessageSquareIcon className="size-3.5 shrink-0 text-sidebar-foreground/40" />
              <span className="truncate text-xs text-sidebar-foreground/80">{c.title}</span>
              <span className="ml-auto shrink-0 font-mono text-[10px] text-sidebar-foreground/35">
                {fmtShort(c.updatedAt)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ── nav ────────────────────────────────────────────────────────────────────
const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboardIcon },
  { href: "/projects", label: "Projects", icon: FolderGit2Icon },
  { href: "/looms", label: "Looms", icon: ActivityIcon },
] as const;

function NavGroup({ activeLooms }: { activeLooms: number }) {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <SidebarMenuItem key={href}>
                <SidebarMenuButton isActive={active} tooltip={label} onClick={() => router.push(href)}>
                  <Icon className="size-4 shrink-0" />
                  <span>{label}</span>
                </SidebarMenuButton>
                {href === "/looms" && activeLooms > 0 && (
                  <SidebarMenuBadge
                    className="animate-pulse bg-primary text-primary-foreground"
                    title={`${activeLooms} weaving`}
                  >
                    {activeLooms}
                  </SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function TelarSidebarHeader() {
  const router = useRouter();
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  return (
    <SidebarHeader className="h-14 justify-center border-b">
      <div className={`flex items-center gap-1 ${collapsed ? "justify-center" : "justify-between pr-1"}`}>
        {!collapsed && (
          <button
            type="button"
            onClick={() => router.push("/")}
            className="flex items-center rounded-md px-2 py-1 text-left outline-none"
          >
            <span className="font-heading text-lg font-semibold tracking-tight">telar</span>
          </button>
        )}
        <SidebarTrigger />
      </div>
    </SidebarHeader>
  );
}

function SidebarBody() {
  const { accounts } = useAccounts();
  const tierOf = (name: string) => accounts.find((a) => a.name === name)?.displayTier;

  const [looms, setLooms] = useState<Loom[]>([]);
  const [chats, setChats] = useState<ChatMeta[]>([]);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [plan, setPlan] = useState<Record<string, PlanSnapshot>>({});
  const [ledger, setLedger] = useState<{ session: UsageWindow; weekly: UsageWindow } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const autoRefreshed = useRef(false);

  const [pinnedNames, setPinnedNames] = useStoredList(PINNED_KEY);
  const [storedOrder, setStoredOrder] = useStoredList(WHEEL_ORDER_KEY);

  const refetchUsage = useCallback(async (): Promise<Record<string, PlanSnapshot>> => {
    try {
      const r = await fetch("/api/usage");
      if (!r.ok) return {};
      const d = await r.json();
      const p: Record<string, PlanSnapshot> = d.plan ?? {};
      setPlan(p);
      setLedger(d.ledger ?? null);
      return p;
    } catch {
      return {};
    }
  }, []);

  const runRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetch("/api/usage/refresh", { method: "POST" });
    } catch {
      // best-effort — refetchUsage below surfaces whatever landed
    } finally {
      await refetchUsage();
      setRefreshing(false);
      window.dispatchEvent(new Event("telar:refresh"));
    }
  }, [refetchUsage]);

  const loadAll = useCallback(() => {
    fetch("/api/looms")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setLooms(Array.isArray(d.looms) ? d.looms : []))
      .catch(() => {});
    fetch("/api/chats")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        const list: ChatMeta[] = Array.isArray(d.chats) ? d.chats : [];
        setChats(list.filter((c) => c.project));
      })
      .catch(() => {});
    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setProjects(Array.isArray(d.projects) ? d.projects : []);
      })
      .catch(() => {});
    fetch("/api/usage")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setPlan(d.plan ?? {});
        setLedger(d.ledger ?? null);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadAll();
    window.addEventListener("telar:refresh", loadAll);
    const t = setInterval(loadAll, 10_000);
    return () => {
      window.removeEventListener("telar:refresh", loadAll);
      clearInterval(t);
    };
  }, [loadAll]);

  useEffect(() => {
    if (autoRefreshed.current || accounts.length === 0) return;
    autoRefreshed.current = true;
    const names = accounts.map((a) => a.name);
    void refetchUsage().then((p) => {
      const now = Date.now();
      const stale = names.some((account) => {
        const snap = p[account];
        return !snap || now - snap.capturedAt > PLAN_STALE_MS;
      });
      if (stale) void runRefresh();
    });
  }, [accounts, refetchUsage, runRefresh]);

  const { state } = useSidebar();
  const collapsed = state === "collapsed";

  const activeLooms = looms.filter((r) => !isTerminal(r.state));
  const activeProjectNames = new Set(activeLooms.map((r) => r.project));

  // Per-project recency = the freshest touch (chat or loom); fall back to when
  // the project was registered.
  const recency = new Map<string, number>();
  const bump = (name: string, ts: number) =>
    recency.set(name, Math.max(recency.get(name) ?? 0, ts));
  for (const c of chats) if (c.project) bump(c.project, c.updatedAt);
  for (const r of looms) bump(r.project, r.updatedAt);

  const derived: SidebarProject[] = projects.map((p) => {
    const name = p.entry.name;
    return {
      name,
      recency: recency.get(name) ?? p.entry.addedAt,
      active: activeProjectNames.has(name),
      looms: activeLooms.filter((l) => l.project === name),
      todayChats: chats
        .filter((c) => c.project === name && isToday(c.updatedAt))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    };
  });
  const byName = new Map(derived.map((d) => [d.name, d]));

  // Pinned: user's order, preserved, only those that still exist.
  const pinnedList = (pinnedNames ?? [])
    .map((n) => byName.get(n))
    .filter((d): d is SidebarProject => d != null);
  const pinnedSet = new Set(pinnedList.map((d) => d.name));

  // Recents: everything not pinned, active-first then by recency, capped.
  const recents = derived
    .filter((d) => !pinnedSet.has(d.name))
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return b.recency - a.recency;
    })
    .slice(0, RECENTS_LIMIT);
  const highlightName = recents.find((d) => d.active)?.name;

  const togglePin = (name: string) => {
    const cur = pinnedNames ?? [];
    setPinnedNames(cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name]);
  };

  // Wheels: one per account that has a captured snapshot, personal first by
  // default; user-chosen order persisted and reconciled against the live set.
  const planEntries = Object.entries(plan).sort(([a], [b]) =>
    a === "personal" ? -1 : b === "personal" ? 1 : a.localeCompare(b),
  );
  const wheelAccounts = new Map<string, WheelAccount>(
    planEntries.map(([name, snap]) => [
      name,
      {
        name,
        subscription: snap.subscriptionType,
        tier: tierOf(name),
        five: snap.fiveHour?.utilization ?? null,
        week: snap.sevenDay?.utilization ?? null,
        snap,
      },
    ]),
  );
  const wheelOrder = reconcile(storedOrder ?? [], planEntries.map(([n]) => n));

  return (
    <>
      <SidebarContent>
        <NavGroup activeLooms={activeLooms.length} />

        {collapsed ? (
          (pinnedList.length > 0 || recents.length > 0) && (
            <SidebarGroup>
              <SidebarGroupContent className="flex flex-col items-center gap-1">
                {pinnedList.map((p) => (
                  <RailProject key={p.name} project={p} />
                ))}
                {pinnedList.length > 0 && recents.length > 0 && (
                  <div className="my-1 h-px w-6 bg-sidebar-border" />
                )}
                {recents.map((p) => (
                  <RailProject key={p.name} project={p} />
                ))}
              </SidebarGroupContent>
            </SidebarGroup>
          )
        ) : (
          <>
            {pinnedList.length > 0 && (
              <SidebarGroup>
                <SidebarGroupLabel>
                  <PinIcon className="mr-1.5 size-3.5" /> Pinned
                </SidebarGroupLabel>
                <SidebarGroupContent className="flex flex-col">
                  {pinnedList.map((p) => (
                    <ProjectRow
                      key={p.name}
                      project={p}
                      pinned
                      onTogglePin={() => togglePin(p.name)}
                    />
                  ))}
                </SidebarGroupContent>
              </SidebarGroup>
            )}

            {recents.length > 0 && (
              <SidebarGroup>
                <SidebarGroupLabel>Recent</SidebarGroupLabel>
                <SidebarGroupContent className="flex flex-col">
                  {recents.map((p) => (
                    <ProjectRow
                      key={p.name}
                      project={p}
                      pinned={false}
                      highlighted={p.name === highlightName}
                      onTogglePin={() => togglePin(p.name)}
                    />
                  ))}
                </SidebarGroupContent>
              </SidebarGroup>
            )}
          </>
        )}
      </SidebarContent>

      <SidebarFooter className="border-t">
        <div className={collapsed ? "flex flex-col items-center gap-2" : "space-y-2 p-1"}>
          <AccountWheels
            accounts={wheelAccounts}
            order={wheelOrder}
            setOrder={setStoredOrder}
            collapsed={collapsed}
            onRefresh={() => void runRefresh()}
            refreshing={refreshing}
            ledger={ledger}
          />
          <SettingsButton collapsed={collapsed} />
        </div>
      </SidebarFooter>
    </>
  );
}

function SettingsButton({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  const active = pathname.startsWith("/settings");
  return (
    <Link
      href="/settings"
      title="Settings"
      className={`flex items-center gap-2 rounded-md text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ${
        active ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : ""
      } ${collapsed ? "size-8 justify-center" : "w-full p-2"}`}
    >
      <SettingsIcon className="size-4 shrink-0" />
      {!collapsed && <span>Settings</span>}
    </Link>
  );
}

export function AppSidebar() {
  return (
    <Sidebar collapsible="icon">
      <TelarSidebarHeader />
      <SidebarBody />
    </Sidebar>
  );
}

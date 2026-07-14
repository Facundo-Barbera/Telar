"use client";

// "Loom started" — replacing the permanent handoff BANNER.
// CURRENT (session-view.tsx:2322): starting a loom pins a full-width banner
// above the transcript — loom icon, "Loom started / The spec bundle is
// committed and weaving …", a "View god-view" button, and an [x]. Three faults
// the owner-log names: it is permanent chrome for a MOMENTARY event; it never
// reflects the loom's ACTUAL state (weaving / blocked / ready); and it eats
// transcript space until manually dismissed. It also can't answer "what if
// multiple looms spring from one session?".
//
// THREE REDESIGNS, all on ONE scripted, replayable timeline
// (start → weave → PARK blocked needing the human → resume → land ready),
// and all designed for N looms from the start. Data shown is deliberately the
// durable minimum — state word, title + short id, elapsed, god-view — no
// thread/gate/last-event detail: the loom UI (threads, gates, progress
// semantics) is still being shaped, and this layer must not freeze
// assumptions about its internals. A reserved slot in the overlay/card marks
// where richer detail lands once that shape settles.
//   A) a compact LIVE aggregate pill in the session bar (RECOMMENDED)
//   B) inline in-stream event rows — the transcript IS the record
//   C) a slim docked live card / tray under the header
//
// TONE FOLLOWS STATE (the doctrine's human-touchpoints surfacing): neutral
// while weaving, amber + a gentle attention pulse when a loom parks and needs
// the human, green at ready. Colors are fixed hues (amber-/emerald-) used only
// as accents (dot, tint, border, ring); every WORD is a theme token
// (muted-foreground / foreground / card-foreground) so it re-themes in both the
// dark shell and a light island — and NO `dark:` utilities, which would leak
// (the app shell is permanently .dark, so the light ThemePair island lives
// under it too).

import { useEffect, useRef, useState } from "react";
import {
  ChevronDownIcon,
  ExternalLinkIcon,
  PanelTopIcon,
  UserRoundIcon,
  WorkflowIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Shimmer } from "./shimmer";
import { DemoShell, Section, ThemePair } from "./_shared";

// ── model ──────────────────────────────────────────────────────────────────

type LoomState = "weaving" | "blocked" | "ready";

// Durable minimum only — no thread/gate counts or last-event text. The loom
// UI (threads, gates, progress semantics) is still being shaped; this layer
// must not freeze assumptions about its internals. Richer detail gets a home
// once that shape settles (see the reserved slot in LoomOverlay below).
interface Loom {
  key: string;
  id: string; // short loom id
  title: string;
  state: LoomState;
  startedAt: number;
  bornAt: number; // for the spawn highlight beat
  changedAt: number; // for the state-change attention pulse
}

const URGENCY: Record<LoomState, number> = { blocked: 3, ready: 2, weaving: 1 };

// Accent-only palette. `text`/`word` still read via a fixed hue chosen to clear
// on BOTH a near-black card and a white card; structural legibility never
// depends on it (the state word can always fall back to a token).
const TONE: Record<
  LoomState,
  { word: string; dot: string; text: string; tint: string; border: string; pulse: boolean }
> = {
  weaving: {
    word: "weaving",
    dot: "bg-muted-foreground/50",
    text: "text-muted-foreground",
    tint: "",
    border: "border-border",
    pulse: false,
  },
  blocked: {
    word: "needs you",
    dot: "bg-amber-500",
    text: "text-amber-600",
    tint: "bg-amber-500/10",
    border: "border-amber-500/40",
    pulse: true,
  },
  ready: {
    word: "ready",
    dot: "bg-emerald-500",
    text: "text-emerald-600",
    tint: "bg-emerald-500/10",
    border: "border-emerald-500/40",
    pulse: false,
  },
};

function maxUrgency(looms: Loom[]): LoomState {
  return looms.reduce<LoomState>(
    (acc, l) => (URGENCY[l.state] > URGENCY[acc] ? l.state : acc),
    "weaving",
  );
}

// The aggregate rollup that drives the pill's label + tone. Single loom → its
// own state + short id; N looms → count + the most-urgent summary (parked and
// ready are both human touchpoints, so they win the rollup over weaving).
function rollup(looms: Loom[]): { state: LoomState; label: string } {
  if (looms.length === 1) {
    const l = looms[0];
    return { state: l.state, label: `${TONE[l.state].word} · ${l.id}` };
  }
  const state = maxUrgency(looms);
  const blocked = looms.filter((l) => l.state === "blocked").length;
  const ready = looms.filter((l) => l.state === "ready").length;
  let sub = "weaving";
  if (blocked) sub = `${blocked} needs you`;
  else if (ready) sub = `${ready} ready`;
  return { state, label: `${looms.length} looms · ${sub}` };
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${String(r).padStart(2, "0")}s` : `${r}s`;
}

// ── the scripted timeline (shared by all three variants) ─────────────────────
// One loom starts and weaves; a SECOND loom spawns mid-run (so aggregates roll
// from single → N); the first PARKS blocked (tone → amber), then resumes; the
// second lands ready, then the first lands ready (tone → green).

const GODVIEW = "#god-view"; // demo-only anchor

function useNow(interval = 500): number {
  const [n, setN] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setN(Date.now()), interval);
    return () => clearInterval(t);
  }, [interval]);
  return n;
}

// Drives loom STATE (variants A + C read this).
function useLoomTimeline(runKey: number): Loom[] {
  const [looms, setLooms] = useState<Loom[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    setLooms([]);
    const at = (ms: number, fn: () => void) => timers.current.push(setTimeout(fn, ms));
    const spawn = (l: Omit<Loom, "startedAt" | "bornAt" | "changedAt">) =>
      setLooms((cur) => [...cur, { ...l, startedAt: Date.now(), bornAt: Date.now(), changedAt: Date.now() }]);
    const patch = (key: string, p: Partial<Loom>) =>
      setLooms((cur) =>
        cur.map((l) =>
          l.key === key
            ? { ...l, ...p, changedAt: p.state && p.state !== l.state ? Date.now() : l.changedAt }
            : l,
        ),
      );

    at(400, () =>
      spawn({ key: "L1", id: "l7f3a2", title: "Refactor auth middleware", state: "weaving" }),
    );
    at(3600, () =>
      spawn({ key: "L2", id: "l9c1e5", title: "Port tests to vitest", state: "weaving" }),
    );
    at(4800, () => patch("L1", { state: "blocked" }));
    at(7400, () => patch("L1", { state: "weaving" }));
    at(8600, () => patch("L2", { state: "ready" }));
    at(10600, () => patch("L1", { state: "ready" }));

    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, [runKey]);

  return looms;
}

// ── shared bits ──────────────────────────────────────────────────────────────

function ReplayBar({ onReplay, note }: { onReplay: () => void; note: string }) {
  return (
    <div className="mb-3 flex items-center gap-3">
      <button
        type="button"
        onClick={onReplay}
        className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        Replay
      </button>
      <span className="text-[11px] text-muted-foreground/70">{note}</span>
    </div>
  );
}

// A gentle attention pulse used when a loom parks (needs the human).
function Pulse() {
  return (
    <span className="relative flex size-1.5 shrink-0">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500/60" />
      <span className="relative inline-flex size-1.5 rounded-full bg-amber-500" />
    </span>
  );
}

function GodViewLink({ compact }: { compact?: boolean }) {
  return (
    <a
      href={GODVIEW}
      onClick={(e) => e.preventDefault()}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground",
        !compact && "border border-border px-1.5 py-0.5",
      )}
    >
      god-view
      <ExternalLinkIcon className="size-2.5" />
    </a>
  );
}

// A colored state chip (dot + word), token-legible in both themes.
function StateChip({ state }: { state: LoomState }) {
  const t = TONE[state];
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn("size-1.5 shrink-0 rounded-full", t.dot)} />
      <span className={cn("text-[10px] font-medium", t.text)}>{t.word}</span>
      {t.pulse && <Pulse />}
    </span>
  );
}

// ── A) the aggregate looms pill ──────────────────────────────────────────────

// The pill visual on its own (reused by the header pill and the collapsed
// docked tray). ONE looms pill, never one per loom.
function AggregateBadge({
  looms,
  justSpawned,
  pinned,
}: {
  looms: Loom[];
  justSpawned: boolean;
  pinned?: boolean;
}) {
  const r = rollup(looms);
  const t = TONE[r.state];
  return (
    <Badge
      variant="outline"
      className={cn(
        "cursor-pointer gap-1.5 font-mono text-xs transition-shadow",
        t.tint,
        t.border,
        pinned && "ring-1 ring-ring",
        justSpawned && "ring-1 ring-primary",
      )}
    >
      <WorkflowIcon className={cn("size-3", t.text)} />
      <span className={cn("font-medium", t.text)}>{r.label}</span>
      {t.pulse && <Pulse />}
    </Badge>
  );
}

// The hover overlay: one row PER loom — title, short id, state, elapsed, and a
// per-row god-view link. Deliberately durable-minimum: no thread/gate detail,
// no last-event line — the loom UI is still being shaped, so this layer must
// not freeze assumptions about its internals. Hover previews, click pins —
// the lane's established pill grammar, zero reflow (it is absolutely positioned).
function LoomOverlay({ looms, now }: { looms: Loom[]; now: number }) {
  return (
    <div className="w-80 rounded-xl border border-border bg-card p-2 text-card-foreground shadow-lg">
      <div className="mb-1.5 flex items-center justify-between px-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
          Looms in this session
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">{looms.length}</span>
      </div>
      <ul className="space-y-0.5">
        {looms.map((l) => (
          <li key={l.key} className="rounded-md px-1.5 py-1.5 hover:bg-muted/50">
            <div className="flex items-center gap-1.5">
              <WorkflowIcon className={cn("size-3 shrink-0", TONE[l.state].text)} />
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{l.title}</span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">{l.id}</span>
            </div>
            <div className="mt-1 flex items-center justify-between pl-4">
              <StateChip state={l.state} />
              <span className="font-mono text-[9px] text-muted-foreground/60">
                {fmtElapsed(now - l.startedAt)}
              </span>
            </div>
            <div className="mt-1.5 flex items-center justify-end pl-4">
              <GodViewLink compact />
            </div>
          </li>
        ))}
      </ul>
      {/* details land when the loom view ships — reserved for thread/gate
          progress once that shape is settled; intentionally empty for now. */}
      <div className="mt-1.5 border-t border-border px-1.5 pt-1.5 text-[10px] text-muted-foreground/60">
        details land when the loom view ships
      </div>
    </div>
  );
}

// The pill as it sits in the session heartbeat bar. Spawns with a brief
// highlight beat on loom start (no banner); hover opens the overlay; click pins.
function LoomsPill({ looms, now }: { looms: Loom[]; now: number }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  if (looms.length === 0) return null;
  const open = hovered || pinned;
  const justSpawned = looms.some((l) => now - l.bornAt < 1300);

  return (
    <div
      className="relative inline-flex items-center leading-none"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={() => setPinned((v) => !v)}
        aria-expanded={open}
        title={pinned ? "Click to unpin" : "Hover to preview · click to pin"}
      >
        <AggregateBadge looms={looms} justSpawned={justSpawned} pinned={pinned} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1.5">
          <LoomOverlay looms={looms} now={now} />
        </div>
      )}
    </div>
  );
}

// A mock session heartbeat bar mirroring real anatomy (account, session id,
// then the ml-auto pills). The looms pill sits next to CTX / cost.
function HeaderBar({ looms, now }: { looms: Loom[]; now: number }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5">
      <Badge variant="outline" className="gap-1.5 font-mono text-xs">
        <UserRoundIcon className="size-3" />
        anthropic · opus
      </Badge>
      <Badge variant="secondary" className="font-mono text-xs">
        a1b2c3d4
      </Badge>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <LoomsPill looms={looms} now={now} />
        <Badge variant="outline" className="font-mono text-xs">
          CTX 58.2k
        </Badge>
        <Badge variant="outline" className="font-mono text-xs">
          $0.53
        </Badge>
      </div>
    </div>
  );
}

function PillLive({ runKey }: { runKey: number }) {
  const looms = useLoomTimeline(runKey);
  const now = useNow();
  return <HeaderBar looms={looms} now={now} />;
}

export function LoomNotifyPillDemo() {
  const [runKey, setRunKey] = useState(0);
  // A representative multi-loom state for the static overlay showcase.
  const now = Date.now();
  const sample: Loom[] = [
    { key: "a", id: "l7f3a2", title: "Refactor auth middleware", state: "blocked", startedAt: now - 214_000, bornAt: 0, changedAt: 0 },
    { key: "b", id: "l9c1e5", title: "Port tests to vitest", state: "ready", startedAt: now - 176_000, bornAt: 0, changedAt: 0 },
  ];

  return (
    <DemoShell>
      <Section
        title="Aggregate looms pill in the session bar"
        note="The banner is gone. A single live pill sits with CTX/cost and never grows to one-per-loom: solo → its state + short id; multiple → count + most-urgent rollup (‘2 looms · 1 needs you’). Tone follows the most-urgent loom — neutral weaving, amber + pulse when a loom parks and needs you, green at ready. On start the pill spawns with a brief highlight beat; a second loom joins mid-run so it rolls single → aggregate. Hover for the per-loom overlay, click to pin. Replay restarts."
      >
        <ReplayBar
          onReplay={() => setRunKey((k) => k + 1)}
          note="start → weave → park (needs you) → resume → ready · a 2nd loom joins at ~3.6s"
        />
        <ThemePair className="items-start">
          <PillLive runKey={runKey} />
        </ThemePair>
      </Section>

      <Section
        title="The hover overlay, pinned open"
        note="One row per loom — title, short id, state, elapsed, and a per-row god-view link. Deliberately minimal: no thread/gate detail while the loom UI is still being shaped, with a reserved slot for it once that lands. Reads in both themes because every word is a theme token and color is accent-only."
      >
        <ThemePair className="items-start">
          <LoomOverlay looms={sample} now={now} />
        </ThemePair>
      </Section>
    </DemoShell>
  );
}

// ── B) inline in-stream event rows ───────────────────────────────────────────

type RowKind = "started" | "blocked" | "resumed" | "ready";

// Durable minimum only — no activity/last-event text, just the state word.
interface EventRow {
  id: number;
  loomId: string;
  title: string;
  kind: RowKind;
  at: number;
}

const ROW_TONE: Record<RowKind, LoomState> = {
  started: "weaving",
  blocked: "blocked",
  resumed: "weaving",
  ready: "ready",
};

const ROW_VERB: Record<RowKind, string> = {
  started: "Loom started",
  blocked: "Loom parked",
  resumed: "Loom resumed",
  ready: "Loom ready",
};

// Drives the append-only event LOG (variant B). Two looms interleave; every row
// carries its short id so the transcript record stays unambiguous.
function useEventLog(runKey: number): EventRow[] {
  const [rows, setRows] = useState<EventRow[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    setRows([]);
    let n = 0;
    const at = (ms: number, r: Omit<EventRow, "id" | "at">) =>
      timers.current.push(
        setTimeout(() => {
          n += 1;
          setRows((cur) => [...cur, { ...r, id: n, at: Date.now() }]);
        }, ms),
      );

    at(400, { loomId: "l7f3a2", title: "Refactor auth middleware", kind: "started" });
    at(3600, { loomId: "l9c1e5", title: "Port tests to vitest", kind: "started" });
    at(4800, { loomId: "l7f3a2", title: "Refactor auth middleware", kind: "blocked" });
    at(7400, { loomId: "l7f3a2", title: "Refactor auth middleware", kind: "resumed" });
    at(8600, { loomId: "l9c1e5", title: "Port tests to vitest", kind: "ready" });
    at(10600, { loomId: "l7f3a2", title: "Refactor auth middleware", kind: "ready" });

    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, [runKey]);

  return rows;
}

function InlineRow({ row, now }: { row: EventRow; now: number }) {
  const t = TONE[ROW_TONE[row.kind]];
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border bg-muted/20 px-2.5 py-1.5 text-xs",
        t.border,
        t.tint,
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center rounded-md border border-border bg-background">
        <WorkflowIcon className={cn("size-3", t.text)} />
      </span>
      <span className={cn("shrink-0 font-medium", t.text)}>{ROW_VERB[row.kind]}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">· {row.title}</span>
      {ROW_TONE[row.kind] === "blocked" && <Pulse />}
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">{row.loomId}</span>
      <span className="shrink-0 font-mono text-[9px] text-muted-foreground/50">{fmtElapsed(now - row.at)}</span>
      <GodViewLink compact />
    </div>
  );
}

function InlineTranscript({ runKey }: { runKey: number }) {
  const rows = useEventLog(runKey);
  const now = useNow();
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [rows.length]);

  return (
    <div
      ref={scroller}
      className="max-h-72 space-y-2.5 overflow-y-auto rounded-lg border border-border bg-card p-3"
    >
      {/* static transcript context so the event rows read as real in-stream turns */}
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg bg-primary/10 px-3 py-1.5 text-xs text-foreground">
          Ship the auth refactor and port the test suite — start looms for both.
        </div>
      </div>
      <div className="text-xs leading-relaxed text-foreground/90">
        On it. Committing the spec bundle for the auth refactor and handing it to a loom.
      </div>
      {rows.map((r) => (
        <InlineRow key={r.id} row={r} now={now} />
      ))}
      {rows.length < 6 && (
        <Shimmer as="div" className="pl-0.5 text-[11px]">
          working · looms weaving
        </Shimmer>
      )}
    </div>
  );
}

export function LoomNotifyInlineDemo() {
  const [runKey, setRunKey] = useState(0);
  return (
    <DemoShell>
      <Section
        title="Inline in-stream event rows — no persistent chrome"
        note="Loom-start renders as a compact event row at the exact turn (tool-step grammar: glyph + ‘Loom started · <title>’ + elapsed + god-view link), and scrolls away with history. State changes append further rows — parked (amber + pulse), resumed, ready (green) — so the transcript IS the record. Two looms interleave here; every row carries its short id so the log stays unambiguous. Rows are deliberately minimal — no activity/last-event text — while the loom UI is still being shaped. Composes with variant A: the pill is live status, these rows are the durable record. Replay restarts."
      >
        <ReplayBar
          onReplay={() => setRunKey((k) => k + 1)}
          note="two looms, six rows, interleaved in-stream"
        />
        <ThemePair className="items-start">
          <InlineTranscript runKey={runKey} />
        </ThemePair>
      </Section>
    </DemoShell>
  );
}

// ── C) docked live card / tray ───────────────────────────────────────────────

function LoomCard({ loom, now, highlighted }: { loom: Loom; now: number; highlighted: boolean }) {
  const t = TONE[loom.state];
  return (
    <div
      className={cn(
        "rounded-lg border bg-card px-3 py-2 transition-shadow",
        t.border,
        t.tint,
        highlighted && "ring-1 ring-ring",
      )}
    >
      <div className="flex items-center gap-2">
        <WorkflowIcon className={cn("size-3.5 shrink-0", t.text)} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{loom.title}</span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">{loom.id}</span>
        <StateChip state={loom.state} />
        <GodViewLink />
      </div>
      {/* details land when the loom view ships — reserved for thread/gate
          progress once that shape is settled */}
      <div className="mt-1.5 flex items-center justify-end">
        <span className="shrink-0 font-mono text-[9px] text-muted-foreground/50">
          {fmtElapsed(now - loom.startedAt)}
        </span>
      </div>
    </div>
  );
}

function DockedTray({ runKey }: { runKey: number }) {
  const looms = useLoomTimeline(runKey);
  const now = useNow();
  const [collapsed, setCollapsed] = useState(false);
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const prev = useRef<Record<string, LoomState>>({});
  const hlTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Auto re-expand + highlight only the ESCALATING loom (→ parked or → ready).
  useEffect(() => {
    for (const l of looms) {
      const was = prev.current[l.key];
      if (was && was !== l.state && (l.state === "blocked" || l.state === "ready")) {
        setCollapsed(false);
        setHighlightKey(l.key);
        clearTimeout(hlTimer.current);
        hlTimer.current = setTimeout(() => setHighlightKey(null), 1800);
      }
      prev.current[l.key] = l.state;
    }
  }, [looms]);

  useEffect(() => {
    // reset collapse/highlight when the timeline replays
    setCollapsed(false);
    setHighlightKey(null);
    prev.current = {};
  }, [runKey]);

  if (looms.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[11px] text-muted-foreground/60">
        no loom started yet
      </div>
    );
  }

  if (collapsed) {
    return (
      <div className="flex justify-end">
        <button type="button" onClick={() => setCollapsed(false)} title="Expand docked looms">
          <AggregateBadge looms={looms} justSpawned={false} />
        </button>
      </div>
    );
  }

  const multi = looms.length > 1;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between px-0.5">
        <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
          <PanelTopIcon className="size-3" />
          {multi ? `${looms.length} looms weaving` : "Docked loom"}
        </span>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="Collapse to the aggregate pill"
        >
          collapse
          <ChevronDownIcon className="size-3" />
        </button>
      </div>
      {looms.map((l) => (
        <LoomCard key={l.key} loom={l} now={now} highlighted={highlightKey === l.key} />
      ))}
    </div>
  );
}

export function LoomNotifyCardDemo() {
  const [runKey, setRunKey] = useState(0);
  return (
    <DemoShell>
      <Section
        title="Docked live card, collapsible to the pill"
        note="A slim card docks under the header with title, short id, state, elapsed, and a god-view button — deliberately minimal, no thread/gate detail while the loom UI is still being shaped. Collapse it to the aggregate A pill any time. When N>1 the cards stack into a slim tray; when a loom PARKS (needs you) or lands READY the tray auto-re-expands and highlights ONLY the escalating card — momentary attention, not permanent chrome. Replay restarts."
      >
        <ReplayBar
          onReplay={() => setRunKey((k) => k + 1)}
          note="collapse it, then watch it auto-re-expand when a loom parks / lands ready"
        />
        <ThemePair className="items-start">
          <DockedTray runKey={runKey} />
        </ThemePair>
      </Section>
    </DemoShell>
  );
}

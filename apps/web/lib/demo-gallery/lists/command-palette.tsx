"use client";

// LANE: lists — extra: global quick-switcher (⌘K). Search-first navigation is
// the throughline of the index redesigns; at 16 projects / 34 sessions / 24
// looms the fastest path to anything is type-to-jump. There is no such affordance
// today. This demo is the always-open palette: one fuzzy field over every
// project, session, and loom, grouped results, keyboard hints, recent when empty.
import { useMemo, useState } from "react";
import {
  CornerDownLeftIcon,
  FolderGit2Icon,
  HammerIcon,
  MessagesSquareIcon,
  SearchIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { StateBadge } from "@/components/common/state-badge";
import { fmtAgo } from "@/lib/format";
import { DEMO_LOOMS, DEMO_PROJECTS, DEMO_SESSIONS } from "./fixtures";
import { railClass } from "./shared";

type Hit =
  | { kind: "project"; id: string; title: string; sub: string }
  | { kind: "session"; id: string; title: string; sub: string; ts: number }
  | {
      kind: "loom";
      id: string;
      title: string;
      sub: string;
      ts: number;
      state: (typeof DEMO_LOOMS)[number]["state"];
    };

export function CommandPaletteDemo() {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);

  const { projects, sessions, looms, flat } = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (s: string) => !needle || s.toLowerCase().includes(needle);

    const projects: Hit[] = DEMO_PROJECTS.filter(
      (p) => match(p.name) || match(p.stack) || match(p.blurb),
    )
      .slice(0, 5)
      .map((p) => ({
        kind: "project",
        id: p.name,
        title: p.name,
        sub: `${p.account} · ${p.stack} · ${p.openLooms} open`,
      }));

    const looms: Hit[] = DEMO_LOOMS.filter((l) => match(l.title) || match(l.project))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 6)
      .map((l) => ({
        kind: "loom",
        id: l.id,
        title: l.title,
        sub: l.project,
        ts: l.updatedAt,
        state: l.state,
      }));

    const sessions: Hit[] = DEMO_SESSIONS.filter((s) => match(s.title) || match(s.project))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 6)
      .map((s) => ({
        kind: "session",
        id: s.id,
        title: s.title,
        sub: s.project,
        ts: s.updatedAt,
      }));

    const flat = [...projects, ...looms, ...sessions];
    return { projects, sessions, looms, flat };
  }, [q]);

  const activeId = flat[Math.min(active, flat.length - 1)]?.id;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    }
  };

  const Row = ({ hit }: { hit: Hit }) => {
    const on = hit.id === activeId;
    const Icon =
      hit.kind === "project" ? FolderGit2Icon : hit.kind === "loom" ? HammerIcon : MessagesSquareIcon;
    return (
      <button
        type="button"
        onMouseEnter={() => setActive(flat.findIndex((h) => h.id === hit.id))}
        className={cn(
          "relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors",
          on ? "bg-muted" : "hover:bg-muted/50",
        )}
      >
        {hit.kind === "loom" && (
          <span
            aria-hidden
            className={cn(
              "absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full",
              railClass(hit.state),
            )}
          />
        )}
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm">{hit.title}</span>
          <span className="block truncate text-xs text-muted-foreground">{hit.sub}</span>
        </div>
        {hit.kind === "loom" && <StateBadge state={hit.state} className="shrink-0" />}
        {"ts" in hit && (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {fmtAgo(hit.ts)}
          </span>
        )}
        {on && (
          <CornerDownLeftIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>
    );
  };

  const Section = ({ label, hits }: { label: string; hits: Hit[] }) =>
    hits.length === 0 ? null : (
      <div className="px-1.5 py-1">
        <div className="px-2 pt-1 pb-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground/70 uppercase">
          {label}
        </div>
        {hits.map((h) => (
          <Row key={h.id} hit={h} />
        ))}
      </div>
    );

  return (
    <div className="flex h-full items-start justify-center bg-black/40 px-4 pt-[8vh]">
      <div className="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-center gap-3 border-b border-border px-4">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search projects, sessions, looms…"
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            ⌘K
          </kbd>
        </div>

        <div className="max-h-[52vh] overflow-y-auto py-1">
          {flat.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              No matches for “{q}”.
            </div>
          ) : (
            <>
              <Section label="Projects" hits={projects} />
              <Section label="Looms" hits={looms} />
              <Section label="Sessions" hits={sessions} />
            </>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border bg-muted px-1 font-mono">↑</kbd>
            <kbd className="rounded border border-border bg-muted px-1 font-mono">↓</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border bg-muted px-1 font-mono">↵</kbd>
            open
          </span>
          <span className="ml-auto font-mono">{flat.length} results</span>
        </div>
      </div>
    </div>
  );
}

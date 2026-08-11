"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronRightIcon, SearchIcon } from "lucide-react";
import { demoGroups } from "@/lib/demo-gallery/registry";
import type { DemoEntry } from "@/lib/demo-gallery/registry";

function matches(e: DemoEntry, q: string): boolean {
  if (!q) return true;
  const hay = `${e.id} ${e.title} ${e.concern} ${e.variant ?? ""} ${e.summary}`.toLowerCase();
  return hay.includes(q.toLowerCase());
}

// Sticky grouped sidebar nav — mirrors the /gallery nav (filter + collapsible
// groups) and adds j/k to move a highlight through the visible list, Enter to
// open. Keyboard is ignored while focus is in the filter input.
export function DemoNav() {
  const pathname = usePathname();
  const router = useRouter();
  const groups = useMemo(() => demoGroups(), []);

  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const q = filter.trim();

  // Visible groups after filtering, plus the flat list the cursor walks.
  const visibleGroups = useMemo(
    () =>
      groups
        .map((g) => ({ ...g, entries: g.entries.filter((e) => matches(e, q)) }))
        .filter((g) => g.entries.length > 0 && !(collapsed[g.key] && !q)),
    [groups, q, collapsed],
  );
  const flat = useMemo(() => visibleGroups.flatMap((g) => g.entries), [visibleGroups]);

  // Keep the cursor in range as the filtered list shrinks/grows.
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, flat.length - 1)));
  }, [flat.length]);

  // Keyboard nav belongs to the index route only. On a stage page the sidebar
  // is still visible, but j/k/↵ there drive DemoStageHeader's prev/next pager —
  // binding them here too would double-fire. Scope this handler to the index.
  const onIndex = pathname === "/demo-gallery";

  useEffect(() => {
    if (!onIndex) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const inField =
        !!el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable);
      // "/" focuses the filter from anywhere outside a field.
      if (e.key === "/" && !inField) {
        e.preventDefault();
        inputRef.current?.focus();
        return;
      }
      if (inField) return;
      if (flat.length === 0) return;
      if (e.key === "j") {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, flat.length - 1));
      } else if (e.key === "k") {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
      } else if (e.key === "Enter") {
        const target = flat[cursor];
        if (target) {
          e.preventDefault();
          router.push(`/demo-gallery/${target.id}`);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flat, cursor, router, onIndex]);

  return (
    <nav className="hidden w-72 shrink-0 flex-col overflow-hidden border-r border-border bg-muted/20 md:flex">
      <div className="shrink-0 space-y-2 p-3">
        <Link
          href="/demo-gallery"
          className={`block rounded-md px-2 py-1.5 text-sm font-medium transition-colors hover:bg-muted ${
            pathname === "/demo-gallery" ? "bg-muted text-foreground" : "text-muted-foreground"
          }`}
        >
          Redesign index
        </Link>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
          <input
            ref={inputRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…  ( / to focus · j/k/↵ )"
            className="w-full rounded-md border border-border bg-background py-1 pl-7 pr-2 text-xs outline-none placeholder:text-muted-foreground/50 focus-visible:border-primary/40"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-8">
        {flat.length === 0 && (
          <p className="px-2 py-4 text-xs text-muted-foreground/60">No matching entry.</p>
        )}
        {groups.map((group) => {
          const entries = group.entries.filter((e) => matches(e, q));
          if (entries.length === 0) return null;
          const isCollapsed = collapsed[group.key] && !q;
          return (
            <div key={group.key}>
              <button
                type="button"
                onClick={() =>
                  setCollapsed((c) => ({ ...c, [group.key]: !c[group.key] }))
                }
                className="flex w-full items-center gap-1 px-1 pb-1 text-left"
              >
                <ChevronRightIcon
                  className={`size-3 text-muted-foreground/60 transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                />
                <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground/80">
                  {group.label}
                </span>
                <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/50">
                  {entries.length}
                </span>
              </button>

              {!isCollapsed && (
                <ul className="space-y-0.5 pl-2">
                  {entries.map((e) => {
                    const href = `/demo-gallery/${e.id}`;
                    const active = pathname === href;
                    const isCursor = flat[cursor]?.id === e.id;
                    return (
                      <li key={e.id}>
                        <Link
                          href={href}
                          onMouseEnter={() =>
                            setCursor(flat.findIndex((f) => f.id === e.id))
                          }
                          className={`flex items-start gap-1.5 rounded-md px-2 py-1 text-xs leading-snug transition-colors hover:bg-muted ${
                            active
                              ? "bg-primary/10 font-medium text-foreground"
                              : isCursor
                                ? "bg-muted text-foreground"
                                : "text-muted-foreground"
                          }`}
                        >
                          <span className="mt-px shrink-0 rounded bg-muted px-1 font-mono text-[9px] leading-tight text-muted-foreground/80">
                            {e.concern}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate">{e.title}</span>
                            {e.variant && (
                              <span className="block truncate text-[10px] text-muted-foreground/60">
                                {e.variant}
                              </span>
                            )}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronRightIcon, SearchIcon } from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { gallerySections, orderedCatalog } from "./gallery-groups";
import type { CatalogItem } from "./gallery-groups";

function matches(item: CatalogItem, q: string): boolean {
  if (!q) return true;
  const hay = `${item.id} ${item.label} ${item.description}`.toLowerCase();
  return hay.includes(q.toLowerCase());
}

export function GalleryNav() {
  const pathname = usePathname();
  const router = useRouter();
  const sections = useMemo(() => gallerySections(), []);
  const allItems = useMemo(() => orderedCatalog(), []);

  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Cmd+K / Ctrl+K opens the fuzzy command palette. Reuses cmdk (already a dep).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const q = filter.trim();

  return (
    <>
      <nav className="hidden w-64 shrink-0 flex-col overflow-hidden border-r border-border bg-muted/20 md:flex">
        <div className="shrink-0 space-y-2 p-3">
          <Link
            href="/gallery"
            className={`block rounded-md px-2 py-1.5 text-sm font-medium transition-colors hover:bg-muted ${
              pathname === "/gallery" ? "bg-muted text-foreground" : "text-muted-foreground"
            }`}
          >
            Catalog index
          </Link>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter…  (⌘K to jump)"
              className="w-full rounded-md border border-border bg-background py-1 pl-7 pr-2 text-xs outline-none placeholder:text-muted-foreground/50 focus-visible:border-primary/40"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-8">
          {sections.map((section) => {
            const groups = section.groups
              .map((g) => ({ ...g, items: g.items.filter((i) => matches(i, q)) }))
              .filter((g) => g.items.length > 0);
            if (groups.length === 0) return null;
            const shownCount = groups.reduce((n, g) => n + g.items.length, 0);
            const isCollapsed = collapsed[section.id] && !q;

            return (
              <div key={section.id}>
                <button
                  type="button"
                  onClick={() => setCollapsed((c) => ({ ...c, [section.id]: !c[section.id] }))}
                  className="flex w-full items-center gap-1 px-1 pb-1 text-left"
                >
                  <ChevronRightIcon
                    className={`size-3 text-muted-foreground/60 transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                  />
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground/80">
                    {section.label}
                  </span>
                  <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/50">
                    {shownCount}
                  </span>
                </button>

                {!isCollapsed &&
                  groups.map((g) => (
                    <div key={g.key} className="mb-2 pl-2">
                      {/* Group sub-header + per-group coverage count. */}
                      <p className="flex items-baseline gap-1.5 px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                        {g.label}
                        <span className="font-normal text-muted-foreground/40">{g.items.length}</span>
                      </p>
                      <ul className="space-y-0.5">
                        {g.items.map((e) => {
                          const href = `/gallery/${e.id}`;
                          const active = pathname === href;
                          return (
                            <li key={e.id}>
                              <Link
                                href={href}
                                className={`block rounded-md px-2 py-1 text-xs leading-snug transition-colors hover:bg-muted ${
                                  active
                                    ? "bg-primary/10 font-medium text-foreground"
                                    : "text-muted-foreground"
                                }`}
                              >
                                {e.label}
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
              </div>
            );
          })}
        </div>
      </nav>

      <CommandDialog open={paletteOpen} onOpenChange={setPaletteOpen}>
        <Command>
          <CommandInput placeholder="Jump to a view…" />
          <CommandList>
            <CommandEmpty>No matching view.</CommandEmpty>
            {sections.map((section) => (
              <CommandGroup key={section.id} heading={section.label}>
                {allItems
                  .filter((i) => i.sectionId === section.id)
                  .map((i) => (
                    <CommandItem
                      key={i.id}
                      value={`${i.id} ${i.label} ${i.description}`}
                      onSelect={() => {
                        setPaletteOpen(false);
                        router.push(`/gallery/${i.id}`);
                      }}
                    >
                      <span className="truncate">{i.label}</span>
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/60">
                        {i.badge}
                      </span>
                    </CommandItem>
                  ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { groupedFixtures } from "./gallery-groups";

export function GalleryNav() {
  const pathname = usePathname();
  const groups = groupedFixtures();

  return (
    <nav className="hidden w-64 shrink-0 overflow-y-auto border-r border-border bg-muted/20 md:block">
      <div className="p-3">
        <Link
          href="/gallery"
          className={`block rounded-md px-2 py-1.5 text-sm font-medium transition-colors hover:bg-muted ${
            pathname === "/gallery" ? "bg-muted text-foreground" : "text-muted-foreground"
          }`}
        >
          Catalog index
        </Link>
      </div>
      <div className="space-y-4 px-3 pb-8">
        {groups.map((g) => (
          <div key={g.group}>
            <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              {g.label}
            </p>
            <ul className="space-y-0.5">
              {g.entries.map((e) => {
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
    </nav>
  );
}

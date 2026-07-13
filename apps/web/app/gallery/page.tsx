import Link from "next/link";
import { GALLERY_FIXTURES } from "@/lib/gallery-fixtures";
import { groupedFixtures } from "./gallery-groups";

export default function GalleryIndexPage() {
  const groups = groupedFixtures();

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-8">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Telar view gallery</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Every view and state of a loom, rendered by the real production
          components fed with fake fixture data. A dev-only design-review surface —
          click through the catalog to review what to improve or mock up next.
        </p>
        <p className="mt-2 text-xs text-muted-foreground/70">
          {GALLERY_FIXTURES.length} entries across {groups.length} lifecycle groups
        </p>
      </header>

      <div className="space-y-8">
        {groups.map((g) => (
          <section key={g.group}>
            <h2 className="mb-3 flex items-baseline gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              {g.label}
              <span className="text-[10px] font-normal text-muted-foreground/60">
                {g.entries.length}
              </span>
            </h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {g.entries.map((e) => (
                <Link
                  key={e.id}
                  href={`/gallery/${e.id}`}
                  className="group flex flex-col rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary/40 hover:bg-muted/40"
                >
                  <span className="text-sm font-medium text-foreground group-hover:text-primary">
                    {e.label}
                  </span>
                  <span className="mt-0.5 text-xs text-muted-foreground">
                    {e.description}
                  </span>
                  <span className="mt-2 font-mono text-[10px] text-muted-foreground/50">
                    {e.surface}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

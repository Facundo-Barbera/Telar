import Link from "next/link";
import { gallerySections, orderedCatalog } from "./gallery-groups";

export default function GalleryIndexPage() {
  const sections = gallerySections();
  const total = orderedCatalog().length;

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-8">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Telar view gallery</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Every view, state and composite component of Telar, rendered by the real
          production components fed with fake fixture data. A dev-only design-review
          surface — click through the catalog, or press <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">⌘K</kbd> to jump.
        </p>
        <p className="mt-2 text-xs text-muted-foreground/70">
          {total} entries across {sections.length} sections —{" "}
          {sections.map((s, i) => (
            <span key={s.id}>
              {i > 0 && ", "}
              {s.count} {s.label.toLowerCase()}
            </span>
          ))}
        </p>
      </header>

      <div className="space-y-10">
        {sections.map((section) => (
          <section key={section.id}>
            <div className="mb-4 flex items-baseline gap-2 border-b border-border pb-1">
              <h2 className="text-base font-semibold tracking-tight">{section.label}</h2>
              <span className="text-xs text-muted-foreground/60">{section.count}</span>
            </div>

            <div className="space-y-6">
              {section.groups.map((g) => (
                <div key={g.key}>
                  {/* Only show a group sub-header when a section has more than
                      one group (the loom section's 12 lifecycle groups). */}
                  {section.groups.length > 1 && (
                    <h3 className="mb-2 flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {g.label}
                      <span className="text-[10px] font-normal text-muted-foreground/50">
                        {g.items.length}
                      </span>
                    </h3>
                  )}
                  <div className="grid gap-2 sm:grid-cols-2">
                    {g.items.map((e) => (
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
                          {e.badge}
                        </span>
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

import Link from "next/link";
import { demoGroups, orderedEntries } from "@/lib/demo-gallery/registry";

// Grouped index — one section per nav group, cards showing title + concern
// badge + variant + summary. Server component: reads only string fields off the
// (client-ref) entries, never their Component.
export default function DemoGalleryIndexPage() {
  const groups = demoGroups();
  const total = orderedEntries().length;

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-8">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Telar redesign gallery</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Candidate redesigns of every core surface, rendered full-screen so each
          can be approved or rejected on its own. Fake fixture data, real visual
          language. Use <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">j</kbd>/<kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">k</kbd> and{" "}
          <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">↵</kbd> in the sidebar to walk the list.
        </p>
        <p className="mt-2 text-xs text-muted-foreground/70">
          {total} {total === 1 ? "candidate" : "candidates"} across {groups.length}{" "}
          {groups.length === 1 ? "group" : "groups"}. Temporary surface — deleted
          after the design pass.
        </p>
      </header>

      {total === 0 && (
        <div className="rounded-lg border border-dashed border-border bg-muted/20 px-6 py-12 text-center text-sm text-muted-foreground">
          No candidates yet. Redesign lanes populate their entries files under{" "}
          <code className="font-mono text-xs">lib/demo-gallery/entries/</code>.
        </div>
      )}

      <div className="space-y-10">
        {groups.map((group) => (
          <section key={group.key}>
            <div className="mb-4 flex items-baseline gap-2 border-b border-border pb-1">
              <h2 className="text-base font-semibold tracking-tight">{group.label}</h2>
              <span className="text-xs text-muted-foreground/60">{group.entries.length}</span>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              {group.entries.map((e) => (
                <Link
                  key={e.id}
                  href={`/demo-gallery/${e.id}`}
                  className="group flex flex-col rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary/40 hover:bg-muted/40"
                >
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {e.concern}
                    </span>
                    <span className="truncate text-sm font-medium text-foreground group-hover:text-primary">
                      {e.title}
                    </span>
                  </div>
                  {e.variant && (
                    <span className="mt-1 w-fit rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-foreground/80">
                      {e.variant}
                    </span>
                  )}
                  <span className="mt-1.5 text-xs text-muted-foreground">{e.summary}</span>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

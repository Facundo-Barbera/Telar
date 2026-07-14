import { notFound } from "next/navigation";
import { getDemoEntry, orderedEntries } from "@/lib/demo-gallery/registry";
import { DemoStageHeader } from "../demo-stage-header";
import type { StageNeighbor } from "../demo-stage-header";

// Full-screen stage for one redesign candidate: header strip + the rendered
// Component. Server component resolves the entry and computes the linear pager;
// the client header owns keyboard nav. Rendering a client-ref Component inside a
// server component is fine — Next resolves it on the client.
export default async function DemoGalleryStagePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const entry = getDemoEntry(id);
  if (!entry) notFound();

  const items = orderedEntries();
  const idx = items.findIndex((e) => e.id === id);
  const prev: StageNeighbor = idx > 0 ? { id: items[idx - 1].id, title: items[idx - 1].title } : null;
  const next: StageNeighbor =
    idx >= 0 && idx < items.length - 1 ? { id: items[idx + 1].id, title: items[idx + 1].title } : null;

  const { Component } = entry;

  return (
    <div className="flex h-full flex-col">
      <DemoStageHeader
        title={entry.title}
        concern={entry.concern}
        summary={entry.summary}
        variant={entry.variant}
        position={idx + 1}
        total={items.length}
        prev={prev}
        next={next}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Component />
      </div>
    </div>
  );
}

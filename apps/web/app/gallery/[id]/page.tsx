import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { GALLERY_FIXTURES, getGalleryFixture } from "@/lib/gallery-fixtures";
import type { GalleryViewHint } from "@/lib/gallery-fixtures";
import { GalleryStage } from "../gallery-stage";

// Reviewer-facing wording for the click hints. NAV HINTS ONLY — never injected
// into a component; they just tell the reviewer what to click after the entry opens.
const HINT_LABEL: Record<GalleryViewHint, string> = {
  orchestrator: "Open the Orchestrator tab",
  threads: "Open the Threads tab",
  verify: "Open the Verify tab",
  chat: "Open the Chat tab",
  "open-decision-rationale": "Click a decision row to expand its rationale",
  "click-discuss": "Click “Discuss” to open the escalation chat",
};

export default async function GalleryEntryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const bundle = getGalleryFixture(id);
  if (!bundle) notFound();

  const idx = GALLERY_FIXTURES.findIndex((f) => f.id === id);
  const prev = idx > 0 ? GALLERY_FIXTURES[idx - 1] : null;
  const next = idx < GALLERY_FIXTURES.length - 1 ? GALLERY_FIXTURES[idx + 1] : null;

  return (
    <div className="flex h-full flex-col">
      {/* Entry chrome: what to look at + reviewer click hints + linear pager. */}
      <div className="shrink-0 border-b border-border bg-muted/20 px-4 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold">{bundle.label}</span>
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {bundle.surface}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{bundle.description}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1 text-xs">
            {prev ? (
              <Link
                href={`/gallery/${prev.id}`}
                className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <ArrowLeftIcon className="size-3" />
                Prev
              </Link>
            ) : (
              <span className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-muted-foreground/30">
                <ArrowLeftIcon className="size-3" />
                Prev
              </span>
            )}
            <span className="px-1 font-mono text-[10px] text-muted-foreground/60">
              {idx + 1}/{GALLERY_FIXTURES.length}
            </span>
            {next ? (
              <Link
                href={`/gallery/${next.id}`}
                className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                Next
                <ArrowRightIcon className="size-3" />
              </Link>
            ) : (
              <span className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-muted-foreground/30">
                Next
                <ArrowRightIcon className="size-3" />
              </span>
            )}
          </div>
        </div>
        {bundle.viewHints && bundle.viewHints.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {bundle.viewHints.map((h) => (
              <span
                key={h}
                className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-foreground/80"
              >
                {HINT_LABEL[h]}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <GalleryStage bundle={bundle} />
      </div>
    </div>
  );
}

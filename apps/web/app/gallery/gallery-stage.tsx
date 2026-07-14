"use client";

import { useState } from "react";
import type { GalleryFixtureBundle } from "@/lib/gallery-fixtures";
import { setActiveScene } from "@/lib/gallery-fixtures";
import { CharterReview, ScopingCharter } from "@/components/looms/charter-review";
import { DiscussEscalation } from "@/components/looms/discuss-escalation";
import { LoomGodView } from "@/components/looms/god-view";
import { AgentViewDrawer } from "@/components/looms/agent-view";
import { SpecDrawer } from "@/components/looms/spec-bundle";
import { ScopingFeed, WorkstreamsPreview } from "@/components/looms/scoping-view";
import { LoomCard } from "@/components/looms/loom-card";
import { SessionView } from "@/components/session/session-view";
import { deriveGodView, deriveThreadOperator } from "@/components/looms/godview";
import { isWoven } from "@/components/looms/utils";

// The crux of the gallery: a faithful mirror of the LoomDetailPage render body
// (apps/web/app/looms/[id]/page.tsx:335-448), fed a STATIC fixture bundle in place
// of the fetch / EventSource / polling plumbing. It composes the IDENTICAL real
// component modules and the IDENTICAL pure derivations — no forks. The data plumbing
// is exactly the part a gallery must replace, so mirroring only these ~40 render
// lines keeps every rendered pixel a real production component.

export function GalleryStage({ bundle }: { bundle: GalleryFixtureBundle }) {
  // Loom entries are served by the loom-keyed resolveGalleryFetch (checked first),
  // so they need no scene — but clear any scene an app/component entry left active
  // (set at render, before child fetch effects) so a stale scene can't answer a
  // stray collection fetch. See app-view-stage.tsx for the ordering rationale.
  setActiveScene(null);

  const { loom, threads, feed, surface } = bundle;

  // Drawer state owned here exactly like page.tsx (:64-65), seeded from the bundle
  // so a Drawers entry opens pre-expanded.
  const [openOperatorId, setOpenOperatorId] = useState<string | null>(
    bundle.openOperatorId ?? null,
  );
  const [specOpen, setSpecOpen] = useState(!!bundle.openSpec);

  // Journey index: the LoomCard grid over the fixture set (root + threads carry
  // the cards, per the frozen fixture shape).
  if (surface === "loom-cards") {
    const cards = [loom, ...threads];
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {cards.map((l) => (
            <LoomCard key={l.id} loom={l} layout="row" showError />
          ))}
        </div>
      </div>
    );
  }

  // Planner / discuss session shell: the REAL SessionView with no live backend
  // (its /api/chat stream is benign-stubbed by the interceptor). Documented
  // limitation — not a fork.
  if (surface === "session") {
    return (
      <div className="flex h-full flex-col">
        <SessionView
          project={loom.project}
          account={loom.account}
          accounts={[{ name: loom.account }]}
          initialTitle={loom.title}
          initialRole="planner"
          planner
        />
      </div>
    );
  }

  // The page-style state routing (page.tsx:409-448).
  if (loom.state === "scoping") {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-8">
        <ScopingCharter />
        <WorkstreamsPreview loomId={loom.id} />
        <ScopingFeed events={feed} />
      </div>
    );
  }
  if (loom.state === "charter-review") return <CharterReview loom={loom} />;
  if (loom.state === "blocked") return <DiscussEscalation loom={loom} />;

  // The unified god-view — mirrors page.tsx:335-447 verbatim (derivations included).
  const view = deriveGodView(loom, threads, feed);

  // When a woven child's drawer is open, prefer its live-tailed operator over the
  // roster's transcript-less one (page.tsx:340-343). In the gallery the child's
  // tail is the bundle feed for that fixture.
  const childLoom = threads.find((t) => t.id === openOperatorId) ?? null;
  const liveThreadOp =
    childLoom && childLoom.id === openOperatorId && isWoven(loom)
      ? deriveThreadOperator(childLoom, feed)
      : null;

  // The RAW loom behind the open operator — root for a single loom, else the child
  // Thread (page.tsx:349-352).
  const openLoom =
    openOperatorId === loom.id
      ? loom
      : (threads.find((t) => t.id === openOperatorId) ?? null);

  // Who accepted — read off the durable "accepted" event (page.tsx:356-358).
  const acceptedBy =
    (feed.findLast((e) => e.type === "accepted")?.by as string | undefined) ??
    undefined;

  return (
    <>
      <LoomGodView
        view={view}
        loom={loom}
        threads={threads}
        onOpenOperator={setOpenOperatorId}
        onViewSpec={() => setSpecOpen(true)}
        onIntervened={() => {}}
        acceptedBy={acceptedBy}
      />
      <AgentViewDrawer
        operator={
          liveThreadOp ??
          view.operators.find((o) => o.id === openOperatorId) ??
          null
        }
        loom={openLoom}
        onIntervened={() => {}}
        onClose={() => setOpenOperatorId(null)}
      />
      <SpecDrawer loomId={loom.id} open={specOpen} onClose={() => setSpecOpen(false)} />
    </>
  );
}

import { notFound } from "next/navigation";
import {
  getGalleryFixture,
  getGalleryAppView,
  getGalleryComponent,
} from "@/lib/gallery-fixtures";
import type { GalleryViewHint } from "@/lib/gallery-fixtures";
import { orderedCatalog } from "../gallery-groups";
import { GalleryEntryHeader } from "../gallery-entry-header";
import { GalleryStage } from "../gallery-stage";
import { AppViewStage } from "../app-view-stage";
import { SessionStage } from "../session-stage";
import { SettingsStage } from "../settings-stage";
import { ComponentStage } from "../component-stage";

// Reviewer-facing wording for the loom click hints. NAV HINTS ONLY — never
// injected into a component; they just tell the reviewer what to click.
const HINT_LABEL: Record<GalleryViewHint, string> = {
  orchestrator: "Open the Orchestrator tab",
  threads: "Open the Threads tab",
  verify: "Open the Verify tab",
  chat: "Open the Chat tab",
  "open-decision-rationale": "Click a decision row to expand its rationale",
  "click-discuss": "Click “Discuss” to open the escalation chat",
};

// One entry route for the WHOLE catalog. Resolve id against the three registries
// in order — loom bundle (existing GalleryStage), then app view (AppView / Session
// / Settings stage), then component showcase (ComponentStage) — and drive a single
// linear prev/next pager over the concatenated catalog (orderedCatalog()).
export default async function GalleryEntryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const items = orderedCatalog();

  const bundle = getGalleryFixture(id);
  const appView = bundle ? undefined : getGalleryAppView(id);
  const component = bundle || appView ? undefined : getGalleryComponent(id);

  if (!bundle && !appView && !component) notFound();

  const viewHints = bundle?.viewHints?.map((h) => HINT_LABEL[h]);

  return (
    <div className="flex h-full flex-col">
      <GalleryEntryHeader items={items} currentId={id} viewHints={viewHints} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {bundle && <GalleryStage bundle={bundle} />}
        {appView &&
          (appView.view === "session-plain" ||
          appView.view === "session-empty" ||
          appView.view === "session-planner" ? (
            <SessionStage entry={appView} />
          ) : appView.view === "settings-accounts" ? (
            <SettingsStage entry={appView} />
          ) : (
            <AppViewStage entry={appView} />
          ))}
        {component && <ComponentStage entry={component} />}
      </div>
    </div>
  );
}

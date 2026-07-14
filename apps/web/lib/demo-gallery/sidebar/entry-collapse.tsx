"use client";

import { SidebarRedesign } from "./sidebar-shell";
import { DemoStage } from "./theme-frame";

// Extra — the collapsed icon rail. Projects become initial glyphs; a pinned or
// recent project with a loom in flight keeps a pulsing primary dot so "who is
// weaving" survives the collapse, and the Looms nav item carries a corner
// pulse. Shown next to the expanded state for direct comparison; both are live
// (toggle either from its header button).
export function SidebarCollapseDemo() {
  return (
    <DemoStage
      controls={() => (
        <p className="text-xs text-muted-foreground">
          Running-loom pulses persist in the rail · toggle from either header
        </p>
      )}
    >
      {() => (
        <div className="mx-auto flex max-w-3xl flex-wrap items-start justify-center gap-10">
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Expanded</span>
            <div className="h-[560px] overflow-hidden rounded-xl border border-border">
              <div className="flex h-full">
                <SidebarRedesign />
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Collapsed rail</span>
            <div className="h-[560px] overflow-hidden rounded-xl border border-border">
              <div className="flex h-full">
                <SidebarRedesign startCollapsed />
              </div>
            </div>
          </div>
        </div>
      )}
    </DemoStage>
  );
}

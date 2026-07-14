"use client";

import { SidebarRedesign, FauxContent } from "./sidebar-shell";
import { DemoStage } from "./theme-frame";

// Concern 3 + 7 — the whole redesigned sidebar, live. Pin/unpin projects (star
// on hover), expand a project to reveal TODAY's active looms + chats nested
// underneath, toggle collapse to see the icon rail with running-loom pulses,
// and note Settings now living at the very bottom. Shown beside a dimmed faux
// page so it reads in context, in both themes.
export function SidebarFullDemo() {
  return (
    <DemoStage
      controls={() => (
        <p className="text-xs text-muted-foreground">
          Hover a project for the pin toggle · click the chevron to nest today ·
          collapse via the header button
        </p>
      )}
    >
      {() => (
        <div className="mx-auto max-w-5xl">
          <div className="flex h-[640px] overflow-hidden rounded-xl border border-border shadow-sm">
            <SidebarRedesign />
            <FauxContent />
          </div>
        </div>
      )}
    </DemoStage>
  );
}

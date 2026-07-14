"use client";

import { AccountWheels } from "./account-wheels";
import { DemoStage } from "./theme-frame";

// Extra — the footer account wheels up close. Two things to try:
//   • Grab any wheel and drop it left/right of another to reorder — a primary
//     bar marks the drop point; the order sticks. Works compact or expanded.
//   • The strip is compact by default (wheels only). Hit the chevron to expand
//     into the per-account detail rows, and collapse back.
// Shown once compact (default) and once pre-expanded so both states read at a
// glance, in a footer-width frame that matches the real sidebar.
export function SidebarAccountWheelsDemo() {
  return (
    <DemoStage
      controls={() => (
        <p className="text-xs text-muted-foreground">
          Drag a wheel to reorder · chevron toggles compact ⇄ detail · order held
          in state (becomes a settings fact when it ships)
        </p>
      )}
    >
      {() => (
        <div className="mx-auto flex max-w-3xl flex-wrap items-start justify-center gap-10">
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Compact (default)
            </span>
            <div className="w-64 rounded-xl border border-sidebar-border bg-sidebar p-2 text-sidebar-foreground">
              <AccountWheels />
            </div>
            <p className="max-w-[16rem] text-xs text-muted-foreground/70">
              Only the wheels — a tight row. Each is a grab handle; hover shows the
              grip.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-foreground">
              Expanded (per-account detail)
            </span>
            <div className="w-64 rounded-xl border border-sidebar-border bg-sidebar p-2 text-sidebar-foreground">
              <AccountWheels startExpanded />
            </div>
            <p className="max-w-[16rem] text-xs text-muted-foreground/70">
              Same wheels, now with account · plan · tier and the 5h/weekly split.
              Rows reorder the same way.
            </p>
          </div>
        </div>
      )}
    </DemoStage>
  );
}

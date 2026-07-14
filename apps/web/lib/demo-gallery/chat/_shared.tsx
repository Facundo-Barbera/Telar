"use client";

// Shared framing + theming for the chat lane's demos. The app shell is
// dark-only (`.dark` hardcoded on <html>), so to show a design in LIGHT we
// re-declare the light token set inline on a wrapper (values lifted verbatim
// from app/globals.css `:root`). Every demo component here uses ONLY semantic
// tokens (bg-card / text-muted-foreground / border-border …) and never a
// `dark:` utility, so flipping the variables genuinely re-themes the subtree.

import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

// app/globals.css :root (light). Kept minimal to the tokens the demos touch.
export const LIGHT_VARS = {
  "--background": "oklch(1 0 0)",
  "--foreground": "oklch(0.145 0 0)",
  "--card": "oklch(1 0 0)",
  "--card-foreground": "oklch(0.145 0 0)",
  "--popover": "oklch(1 0 0)",
  "--popover-foreground": "oklch(0.145 0 0)",
  "--primary": "oklch(0.205 0 0)",
  "--primary-foreground": "oklch(0.985 0 0)",
  "--secondary": "oklch(0.97 0 0)",
  "--secondary-foreground": "oklch(0.205 0 0)",
  "--muted": "oklch(0.97 0 0)",
  "--muted-foreground": "oklch(0.556 0 0)",
  "--accent": "oklch(0.97 0 0)",
  "--accent-foreground": "oklch(0.205 0 0)",
  "--destructive": "oklch(0.577 0.245 27.325)",
  "--border": "oklch(0.922 0 0)",
  "--input": "oklch(0.922 0 0)",
  "--ring": "oklch(0.708 0 0)",
} as CSSProperties;

// Full-height, scrollable canvas for a demo. The stage already provides the
// scroll container; this just sets padding + a comfortable reading measure.
export function DemoShell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("mx-auto w-full max-w-5xl px-6 py-8", className)}>{children}</div>
  );
}

// A titled section with an optional one-line rationale.
export function Section({
  title,
  note,
  children,
  className,
}: {
  title: string;
  note?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mb-8", className)}>
      <div className="mb-3">
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        {note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
      </div>
      {children}
    </section>
  );
}

// Small caption/label above a rendered specimen.
export function Caption({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
      {children}
    </div>
  );
}

// Renders `children` twice — the dark shell default and a re-themed light
// island — in a responsive two-up so a reviewer judges both at once.
export function ThemePair({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-4 md:grid-cols-2", className)}>
      <div>
        <Caption>Dark</Caption>
        <div className="rounded-xl border border-border bg-background p-4 text-foreground">{children}</div>
      </div>
      <div>
        <Caption>Light</Caption>
        <div
          className="rounded-xl border border-border bg-background p-4 text-foreground"
          style={LIGHT_VARS}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

// A light-token island for one-off placements (e.g. showing a single variant
// in light without a paired dark copy).
export function LightIsland({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-xl border border-border bg-background text-foreground", className)} style={LIGHT_VARS}>
      {children}
    </div>
  );
}

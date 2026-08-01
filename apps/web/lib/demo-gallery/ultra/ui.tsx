"use client";

// LANE: ultra (NEW) — self-contained primitives for the Ultra session demo
// (round 26). Kept lane-local on purpose (like project/shared.tsx): the Ultra
// run surface was never covered by a redesign lane, so it re-declares the theme
// frame + a masked shimmer in the exact UI-v2 register rather than reaching
// across a lane fence. Only @/lib/utils + @/lib/format are shared prod code; the
// theme island is gallery-wide (../theme-island) because a private copy of the
// palette is the one thing a lane fence must not protect.
import type { ReactNode } from "react";
import { MoonIcon, SunIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useThemeIsland, type Theme } from "../theme-island";

/* ------------------------------------------------------------------ theming */

// The token block this lane used to transcribe out of globals.css now comes from
// the stylesheet itself — see ../theme-island for why an island is needed at all
// and why it must not be a copy. Re-exported so lane files keep one import site.
export type { Theme };

// Full-height stage: a thin toolbar (theme toggle + demo controls) over a
// token-scoped surface. `text-foreground` re-declares `color` across the token
// boundary so un-classed descendants don't inherit the shell's color.
export function StageFrame({
  controls,
  children,
}: {
  controls?: (theme: Theme) => ReactNode;
  children: (theme: Theme) => ReactNode;
}) {
  const { theme, setTheme, className, style } = useThemeIsland();
  return (
    <div
      className={cn("flex h-full flex-col bg-background text-foreground", className)}
      style={style}
    >
      <ShimmerStyle />
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <ThemeToggle theme={theme} onChange={setTheme} />
        {controls?.(theme)}
      </div>
      <div className="min-h-0 flex-1">{children(theme)}</div>
    </div>
  );
}

function ThemeToggle({
  theme,
  onChange,
}: {
  theme: Theme;
  onChange: (t: Theme) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-md border border-border bg-card p-0.5">
      {(["dark", "light"] as const).map((t) => {
        const Icon = t === "dark" ? MoonIcon : SunIcon;
        const active = theme === t;
        return (
          <button
            key={t}
            type="button"
            onClick={() => onChange(t)}
            className={cn(
              "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium capitalize transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {t}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------- mask shimmer */

// One keyframe, injected once per stage. A travelling mask band reveals a
// brighter copy of the text laid exactly over the class-coloured base, so the
// base can never wash out (the chat-lane shimmer note). Respects reduced-motion.
function ShimmerStyle() {
  return (
    <style
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{
        __html: `
.ultra-shimmer{
  -webkit-mask-image:linear-gradient(90deg,#0000 42%,#000 50%,#0000 58%);
  mask-image:linear-gradient(90deg,#0000 42%,#000 50%,#0000 58%);
  -webkit-mask-size:250% 100%;mask-size:250% 100%;
  -webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;
  animation:ultra-shimmer-sweep 1.9s linear infinite;
}
@keyframes ultra-shimmer-sweep{
  from{-webkit-mask-position:160% center;mask-position:160% center;}
  to{-webkit-mask-position:-60% center;mask-position:-60% center;}
}
@media (prefers-reduced-motion: reduce){.ultra-shimmer{animation:none;opacity:0;}}
`,
      }}
    />
  );
}

// Base label = plain class-coloured text; a second aria-hidden copy in
// text-foreground brightens only a travelling stripe.
export function Shimmer({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <span className={cn("relative inline-block", className)}>
      {children}
      <span
        aria-hidden
        className="ultra-shimmer pointer-events-none absolute inset-0 text-foreground"
      >
        {children}
      </span>
    </span>
  );
}

/* --------------------------------------------------------------------- atoms */

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
}) {
  return (
    <div className="inline-flex items-center rounded-md border border-border bg-card p-0.5">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

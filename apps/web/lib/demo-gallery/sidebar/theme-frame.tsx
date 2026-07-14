"use client";

// Local light/dark theming for sidebar demos. The app shell hard-codes `dark`
// on <html>, so a wrapper can't reach light mode just by omitting the class —
// the custom properties cascade down from the root. Instead we set the token
// values explicitly on the frame element (inline vars) so each preview can show
// both themes side by side regardless of the surrounding shell. Components in
// this lane use only token classes (bg-sidebar, text-sidebar-foreground, …) —
// never `dark:` variant utilities — so this cascade fully controls their look.
import { useState, type CSSProperties, type ReactNode } from "react";
import { MoonIcon, SunIcon } from "lucide-react";

type Vars = Record<string, string>;

const DARK: Vars = {
  "--background": "oklch(0.145 0 0)",
  "--foreground": "oklch(0.985 0 0)",
  "--card": "oklch(0.205 0 0)",
  "--card-foreground": "oklch(0.985 0 0)",
  "--popover": "oklch(0.205 0 0)",
  "--popover-foreground": "oklch(0.985 0 0)",
  "--primary": "oklch(0.922 0 0)",
  "--primary-foreground": "oklch(0.205 0 0)",
  "--secondary": "oklch(0.269 0 0)",
  "--secondary-foreground": "oklch(0.985 0 0)",
  "--muted": "oklch(0.269 0 0)",
  "--muted-foreground": "oklch(0.708 0 0)",
  "--accent": "oklch(0.269 0 0)",
  "--accent-foreground": "oklch(0.985 0 0)",
  "--destructive": "oklch(0.704 0.191 22.216)",
  "--border": "oklch(1 0 0 / 10%)",
  "--input": "oklch(1 0 0 / 15%)",
  "--ring": "oklch(0.556 0 0)",
  "--sidebar": "oklch(0.205 0 0)",
  "--sidebar-foreground": "oklch(0.985 0 0)",
  "--sidebar-primary": "oklch(0.488 0.243 264.376)",
  "--sidebar-primary-foreground": "oklch(0.985 0 0)",
  "--sidebar-accent": "oklch(0.269 0 0)",
  "--sidebar-accent-foreground": "oklch(0.985 0 0)",
  "--sidebar-border": "oklch(1 0 0 / 10%)",
  "--sidebar-ring": "oklch(0.556 0 0)",
};

const LIGHT: Vars = {
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
  "--sidebar": "oklch(0.985 0 0)",
  "--sidebar-foreground": "oklch(0.145 0 0)",
  "--sidebar-primary": "oklch(0.205 0 0)",
  "--sidebar-primary-foreground": "oklch(0.985 0 0)",
  "--sidebar-accent": "oklch(0.97 0 0)",
  "--sidebar-accent-foreground": "oklch(0.205 0 0)",
  "--sidebar-border": "oklch(0.922 0 0)",
  "--sidebar-ring": "oklch(0.708 0 0)",
};

export type Theme = "dark" | "light";

// Wrap any subtree so its tokens resolve to the chosen theme. `--radius` isn't
// overridden — it's theme-independent and inherited from the root.
export function ThemeSurface({
  theme,
  className,
  style,
  children,
}: {
  theme: Theme;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const vars = theme === "dark" ? DARK : LIGHT;
  return (
    <div
      className={className}
      style={{ ...(vars as CSSProperties), ...style }}
    >
      {children}
    </div>
  );
}

// Segmented dark/light control used in demo toolbars.
export function ThemeToggle({
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
            className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="size-3.5" />
            {t}
          </button>
        );
      })}
    </div>
  );
}

// Convenience hook-free stateful toolbar wrapper: gives a theme toggle plus any
// extra controls, and renders children inside a matching ThemeSurface.
export function DemoStage({
  controls,
  children,
  padded = true,
}: {
  controls?: (theme: Theme) => ReactNode;
  children: (theme: Theme) => ReactNode;
  padded?: boolean;
}) {
  const [theme, setTheme] = useState<Theme>("dark");
  return (
    <ThemeSurface
      theme={theme}
      className="flex min-h-full flex-col bg-background text-foreground"
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
        <ThemeToggle theme={theme} onChange={setTheme} />
        {controls?.(theme)}
      </div>
      <div className={padded ? "flex-1 p-6" : "flex-1"}>{children(theme)}</div>
    </ThemeSurface>
  );
}

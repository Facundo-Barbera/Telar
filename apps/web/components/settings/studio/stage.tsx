"use client";

/**
 * THE STAGE — a miniature of the app, painted from the draft and nothing else.
 *
 * Every colour in here resolves from the custom properties `draftCssVars` puts
 * on the container: globals.css bridges `--color-background: var(--background)`
 * inside `@theme inline`, so a utility like `bg-background` compiles to
 * `var(--background)` and reads THIS element's value rather than the document's.
 * That is the whole trick, and it is why the stage can show a night palette
 * while the settings page around it stays in day.
 *
 * IT IS A MOCK, NOT A SECOND RENDERER. The rows, the bubbles and the chip are
 * drawn here to exercise the tokens that are hardest to judge as swatches —
 * `sidebar-accent` only means something as a selected row, `muted` only means
 * something behind code. Nothing here imports a real app component, because a
 * preview that dragged the real sidebar in would drag its stores in too, and
 * those are exactly what the studio is trying not to touch.
 *
 * WHAT IT DELIBERATELY DOES NOT SHOW: the interface text size (Tailwind's
 * sizes are rem, measured from the document root — a miniature that changed
 * with them would rescale the mock rather than the app) and an image
 * backdrop's blur (a filter on the real backdrop element, not a background
 * property). Both are stated in the tools instead of faked here.
 */

import type { CSSProperties } from "react";
import { cssFontFamilies } from "@/lib/appearance";
import { draftBackdropCss, draftCssVars, type StudioDraft, type StudioMode } from "@/lib/studio-draft";
import { cn } from "@/lib/utils";

const ROWS = ["Cockpit redesign", "Engine adapter", "Release notes", "Spool triage"];

/**
 * How much of the backdrop shows through, as the app's own rule states it:
 * `--translucency` is the strength times 0.9 (lib/appearance.ts), and the
 * canvas is that much OPEN. With no backdrop there is nothing to open onto, so
 * the surfaces are solid.
 */
function surface(token: string, open: boolean, level: number): string {
  return open ? `color-mix(in oklab, var(--${token}) ${Math.round(100 - level * 0.9)}%, transparent)` : `var(--${token})`;
}

export function Stage({ draft, mode, className }: { draft: StudioDraft; mode: StudioMode; className?: string }) {
  const open = draft.backdrop.kind !== "none";
  const vars = draftCssVars(draft, mode) as CSSProperties;
  const backdrop = draftBackdropCss(draft, mode);

  // The typeface attributes are the SAME ones globals.css keys its font blocks
  // off — set on this element they retint only the mock, exactly as the accent
  // blocks do for the settings swatches. Custom stacks have no block to wear,
  // so they are written as the variable itself.
  const sansCustom = draft.fontSans === "custom" ? cssFontFamilies(draft.fontSansCustom) : null;
  const monoCustom = draft.fontMono === "custom" ? cssFontFamilies(draft.fontMonoCustom) : null;

  return (
    <div
      className={cn("relative aspect-[16/10] w-full overflow-hidden rounded-xl ring-1 ring-foreground/15", className)}
      style={{
        ...vars,
        ...(sansCustom ? { ["--app-font-sans" as string]: sansCustom } : {}),
        ...(monoCustom ? { ["--app-font-mono" as string]: monoCustom } : {}),
      }}
      data-font-sans={draft.fontSans === "custom" ? undefined : draft.fontSans}
      data-font-mono={draft.fontMono === "custom" ? undefined : draft.fontMono}
      role="img"
      aria-label={`Preview of ${draft.label} in ${mode} scheme`}
    >
      <div className="absolute inset-0" style={backdrop} aria-hidden />

      <div className="absolute inset-0 flex font-sans text-[0.6rem] leading-tight" style={{ color: "var(--foreground)" }} aria-hidden>
        {/* The rail */}
        <div
          className="flex w-[26%] shrink-0 flex-col gap-[3px] p-2"
          style={{ background: surface("sidebar", open, draft.translucencyLevel), borderRight: "1px solid var(--border)" }}
        >
          <div className="mb-1 px-1 text-[0.65rem] font-semibold tracking-tight">Telar</div>
          {ROWS.map((row, index) => (
            <div
              key={row}
              className="truncate rounded-[5px] px-1.5 py-1"
              style={
                index === 1
                  ? { background: "var(--sidebar-accent)", color: "var(--accent-foreground)", fontWeight: 500 }
                  : { color: "var(--muted-foreground)" }
              }
            >
              {row}
            </div>
          ))}
        </div>

        {/* The canvas */}
        <div className="flex min-w-0 flex-1 flex-col" style={{ background: surface("background", open, draft.translucencyLevel) }}>
          <div className="flex items-center gap-1.5 px-3 py-2" style={{ borderBottom: "1px solid var(--border)" }}>
            <span className="size-1.5 rounded-full" style={{ background: "var(--primary)" }} />
            <span className="text-[0.6rem] font-semibold tracking-tight">Engine adapter</span>
            <span className="ml-auto rounded-[4px] px-1.5 py-0.5 text-[0.5rem]" style={{ background: "var(--muted)", color: "var(--muted-foreground)" }}>
              main
            </span>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
            <div className="flex justify-end">
              <span
                className="max-w-[70%] rounded-lg px-2 py-1.5 text-[0.58rem]"
                style={{ background: "var(--secondary)", color: "var(--secondary-foreground)" }}
              >
                Make the adapter retry on a cold start.
              </span>
            </div>

            <div className="max-w-[85%] space-y-1.5">
              <p className="text-[0.58rem]">I added a bounded retry around the handshake and left the timeout where it was.</p>
              <span className="inline-block rounded-[5px] px-1.5 py-1 font-mono text-[0.52rem]" style={{ background: "var(--muted)", color: "var(--foreground)" }}>
                lib/engine/client.ts
              </span>
              <p className="text-[0.52rem]" style={{ color: "var(--muted-foreground)" }}>
                2 files changed · just now
              </p>
            </div>

            <div className="mt-auto flex items-center gap-1.5">
              <div
                className="flex-1 rounded-md px-2 py-1.5 text-[0.55rem]"
                style={{ background: "var(--card)", color: "var(--muted-foreground)", border: "1px solid var(--input)" }}
              >
                Message the agent…
              </div>
              <span
                className="rounded-md px-2 py-1.5 text-[0.55rem] font-medium"
                style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}
              >
                Send
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

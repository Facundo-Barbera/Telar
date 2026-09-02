"use client";

/**
 * THE STUDIO PREVIEW — the draft worn by the real app, without a single store
 * write.
 *
 * The old studio painted its draft onto a 16:10 mock. The mock could not show
 * the text size, an image backdrop's blur, hover states, or four of the
 * sixteen tokens it let you edit — and everything it DID show was a drawing of
 * the app rather than the app. So the preview now goes the other way: while a
 * draft exists, the draft is painted onto the document itself, through exactly
 * the mechanisms the live stores use, and taken off again by replaying those
 * stores. You judge the app you will actually wear.
 *
 * NOTHING HERE TOUCHES A STORE. The preview writes the same surface the
 * appliers write — a <style> element, attributes and inline custom properties
 * on <html> — but from the draft instead of from localStorage. Discard is
 * therefore total by construction: `clearPreview` re-runs the stores' own
 * appliers, and whatever the preview wrote is overwritten by the truth.
 *
 * WHY THE PREVIEW STYLESHEET WINS. The theme library's stylesheet is
 * `html:root { … }` in <style id="telar-theme">. The preview compiles the same
 * selectors at the same specificity and keeps its element LAST in <head>
 * (every apply re-appends it), so it wins by source order — and the
 * translucency/backdrop overrides at (0,2,0) still outrank both, exactly as
 * they do for a worn theme.
 *
 * THE PROVIDERS ARE TOLD TO STAND BACK. appearance-provider.tsx replays the
 * live stores into <html> whenever they change; during a preview that replay
 * would stomp the draft's attributes. The providers check `isPreviewActive`
 * and skip the replay — and since Apply clears the preview immediately after
 * writing the stores, the replay they skipped happens anyway, from here.
 */

import { applyAppearance, cssFontFamilies, currentAppearance, DEFAULT_APPEARANCE, translucencyCss } from "./appearance";
import { applyBackdrop, BACKDROP_KEY, parseBackdrop } from "./backdrop";
import type { Look, LookBackdrop } from "./looks";
import { readTheme } from "@/components/theme-provider";
import { applyThemeCss, THEME_TOKENS } from "./theme-palettes";

const PREVIEW_STYLE_ID = "telar-studio-preview";

export type PreviewMode = "light" | "dark";

let active = false;

/** Whether a draft is currently painted on the document — the providers ask
 *  before replaying the live stores over it. */
export function isPreviewActive(): boolean {
  return active;
}

/** The draft's two halves as the same stylesheet shape the theme library
 *  compiles — pure, so it can be tested without a document. */
export function compilePreviewCss(look: Look): string {
  const declarations = (mode: PreviewMode) =>
    THEME_TOKENS.map((token) => `--${token}: ${look.theme[mode][token]};`).join(" ");
  return `html:root { ${declarations("light")} } html:root.dark { ${declarations("dark")} }`;
}

const BACKDROP_VARS = ["--backdrop-light", "--backdrop-dark", "--backdrop-size", "--backdrop-position", "--backdrop-repeat", "--backdrop-blur", "--backdrop-dim"] as const;

/** The draft's backdrop written the way applyBackdrop writes a live one —
 *  same attribute, same variables, but from the Look's own payloads. */
function previewBackdrop(backdrop: LookBackdrop): void {
  const root = document.documentElement;
  for (const name of BACKDROP_VARS) root.style.removeProperty(name);
  if (backdrop.kind === "none") {
    root.removeAttribute("data-backdrop");
    return;
  }
  if (backdrop.kind === "image") {
    if (!backdrop.image.startsWith("data:image/")) {
      root.removeAttribute("data-backdrop");
      return;
    }
    root.setAttribute("data-backdrop", "image");
    const url = `url("${backdrop.image}")`;
    root.style.setProperty("--backdrop-light", url);
    root.style.setProperty("--backdrop-dark", url);
    root.style.setProperty("--backdrop-size", backdrop.fit === "cover" ? "cover" : backdrop.fit === "fill" ? "100% 100%" : "auto");
    root.style.setProperty("--backdrop-repeat", backdrop.fit === "tile" ? "repeat" : "no-repeat");
    if (backdrop.blur > 0) root.style.setProperty("--backdrop-blur", `${backdrop.blur}px`);
    if (backdrop.dim > 0) root.style.setProperty("--backdrop-dim", `${backdrop.dim}%`);
    return;
  }
  root.setAttribute("data-backdrop", backdrop.kind);
  root.style.setProperty("--backdrop-light", backdrop.resolved.light);
  root.style.setProperty("--backdrop-dark", backdrop.resolved.dark);
  if (backdrop.resolved.size) root.style.setProperty("--backdrop-size", backdrop.resolved.size);
  if (backdrop.resolved.position) root.style.setProperty("--backdrop-position", backdrop.resolved.position);
  if (backdrop.resolved.repeat) root.style.setProperty("--backdrop-repeat", backdrop.resolved.repeat);
}

const CUSTOM_SANS_FALLBACK = "ui-sans-serif, system-ui, sans-serif";
const CUSTOM_MONO_FALLBACK = "ui-monospace, SFMono-Regular, Menlo, monospace";

/**
 * Paint the draft on the document. Idempotent — call it again with the next
 * draft and every surface is rewritten. `mode` forces the colour scheme so the
 * header's Light/Dark toggle can show either half; omitted, the document keeps
 * whichever class it is wearing.
 */
export function previewLook(look: Look, mode?: PreviewMode): void {
  active = true;
  const root = document.documentElement;

  // The stylesheet, kept LAST in <head> so a tie on specificity goes to the
  // draft (appendChild moves an existing element).
  let style = document.getElementById(PREVIEW_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = PREVIEW_STYLE_ID;
  }
  const css = compilePreviewCss(look);
  if (style.textContent !== css) style.textContent = css;
  document.head.appendChild(style);

  // Accent and typefaces through the same attributes the appearance applier
  // uses — the hues stay in globals.css's own blocks, never copied here.
  const set = (name: string, value: string, isDefault: boolean) => {
    if (isDefault) root.removeAttribute(name);
    else root.setAttribute(name, value);
  };
  set("data-accent", look.accent, look.accent === DEFAULT_APPEARANCE.accent);
  set("data-font-sans", look.fontSans, look.fontSans === DEFAULT_APPEARANCE.fontSans);
  set("data-font-mono", look.fontMono, look.fontMono === DEFAULT_APPEARANCE.fontMono);
  const family = (property: string, custom: boolean, raw: string, fallback: string) => {
    const list = custom ? cssFontFamilies(raw) : null;
    if (list === null) root.style.removeProperty(property);
    else root.style.setProperty(property, `${list}, ${fallback}`);
  };
  family("--app-font-sans", look.fontSans === "custom", look.fontSansCustom, CUSTOM_SANS_FALLBACK);
  family("--app-font-mono", look.fontMono === "custom", look.fontMonoCustom, CUSTOM_MONO_FALLBACK);

  if (look.fontSize === DEFAULT_APPEARANCE.fontSize) root.style.removeProperty("font-size");
  else root.style.fontSize = `${look.fontSize}px`;
  root.style.setProperty("--translucency", translucencyCss(look.translucencyLevel));

  previewBackdrop(look.backdrop);

  if (mode !== undefined) root.classList.toggle("dark", mode === "dark");
}

/** Which scheme the document should wear when nothing is forcing one — the
 *  theme store's own resolution, restated because the provider's effect only
 *  runs when the STORE changes and the preview moves the class behind its
 *  back. */
function storedSchemeIsDark(): boolean {
  const theme = readTheme();
  return theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

/**
 * Take the draft off by replaying the truth: every store's own applier runs
 * against its own stored value, overwriting everything previewLook wrote. The
 * preview element itself is removed rather than emptied.
 */
export function clearPreview(): void {
  if (!active) return;
  active = false;
  document.getElementById(PREVIEW_STYLE_ID)?.remove();
  applyThemeCss();
  applyAppearance(currentAppearance());
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(BACKDROP_KEY);
  } catch {
    // Private browsing: no stored backdrop to restore.
  }
  applyBackdrop(parseBackdrop(raw));
  document.documentElement.classList.toggle("dark", storedSchemeIsDark());
}

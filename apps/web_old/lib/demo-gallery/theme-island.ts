"use client";

// One theme island for the whole demo gallery, derived from the live stylesheet.
//
// WHY THIS EXISTS: a demo stage carries its own light/dark toggle, but the app
// shell pins `.dark` on <html> and app/globals.css puts the light palette on
// `:root` — a selector that only ever matches <html>. So a stage cannot reveal
// its light variant by dropping a class the way the rest of the app can; it has
// to re-declare the raw tokens on its own wrapper. Two lanes used to do that by
// transcribing the token block out of globals.css into a JS object, which made
// the gallery — the surface you use to REVIEW a palette — the one place
// guaranteed to render the previous one. Nothing threw and nothing looked
// broken; the colours were simply a version behind.
//
// So read the same two rules back out of the loaded stylesheet instead. A
// palette change lands here for free, and there is no copy left to keep in sync.
//
// WHAT AN ISLAND STILL CANNOT DO, on purpose. A light island gets its TOKENS
// from the inline style below, but `dark:`-scoped utility overrides inside it
// keep firing, because the wrapper is still a descendant of html.dark. The fix
// for that was a `:not(:is(.light *))` clause on the app's `dark` variant, and
// it was reverted: it raised the specificity of every `dark:` rule in the
// shipping app and made a bare `light` class anywhere a silent dark-mode hole,
// which is a bad trade for a surface only developers open. So a light stage is
// accurate about the palette and approximate about `dark:` overrides. If that
// ever matters more than it does today, the answer is to scope the clause to
// the gallery's own stylesheet, not to widen the app's.

import { useState, type CSSProperties } from "react";

export type Theme = "dark" | "light";

// A stage's toggle plus what its wrapper wears. Both halves of the wrapper
// matter: the class alone cannot make a light island, and the style alone cannot
// make a dark one.
export interface ThemeIsland {
  theme: Theme;
  setTheme: (next: Theme) => void;
  className: string;
  style: CSSProperties | undefined;
}

const declares = (rule: CSSStyleRule, selector: string) =>
  rule.selectorText.split(",").some((part) => part.trim() === selector);

// Every custom property `.dark` overrides, mapped back to the value `:root`
// gives it — precisely the declarations that undo the shell's dark theme for one
// subtree. Whatever `.dark` never touches (`--radius` and friends) already
// cascades in correctly and is left alone, which keeps the wrapper's inline
// style at the size of the palette rather than the size of the theme.
// A declaration plus where it came from. `layered` is coarse on purpose — it
// does not rank one @layer against another, only layered against unlayered,
// which is the distinction the compiled sheet actually turns on.
type Declaration = { layered: boolean; value: string };

function readLightIsland(): CSSProperties {
  const root: Record<string, Declaration> = {};
  const dark: Record<string, Declaration> = {};

  const collect = (
    rule: CSSStyleRule,
    into: Record<string, Declaration>,
    layered: boolean,
  ) => {
    for (let i = 0; i < rule.style.length; i++) {
      const prop = rule.style.item(i);
      if (!prop.startsWith("--")) continue;
      // Later wins among equals; unlayered wins over layered whatever the
      // order. The only case that skips is a layered declaration arriving
      // after an unlayered one for the same property.
      const seen = into[prop];
      if (seen && !seen.layered && layered) continue;
      into[prop] = { layered, value: rule.style.getPropertyValue(prop).trim() };
    }
  };

  // Document order is only PART of the cascade, and the compiled sheet proves
  // it: Tailwind emits a `:root, :host` inside `@layer theme` at the top, the
  // palette's own unlayered `:root` in the middle, and a third `:root, :host`
  // inside `@layer properties` at the bottom — the last of which is wrapped in
  // an @supports that is false everywhere but Safari. Read as flat document
  // order, the layered block at the end would beat the unlayered palette,
  // which is backwards: unlayered declarations always win over layered ones
  // regardless of position, and a group whose condition does not match
  // contributes nothing at all.
  //
  // So: skip conditional groups that are not currently true, and let a layered
  // declaration fill a hole but never overwrite an unlayered one. Today only
  // --shimmer-angle is caught by any of this and the .dark diff filters it out
  // anyway — but the moment a palette token is declared inside @layer base
  // (that block already exists in globals.css) or behind a prefers-contrast
  // branch, flat order would silently pick the wrong value, which is the exact
  // failure this module was written to eliminate.
  const conditionHolds = (rule: CSSConditionRule) => {
    try {
      if (rule instanceof CSSMediaRule) {
        return window.matchMedia(rule.conditionText).matches;
      }
      if (rule instanceof CSSSupportsRule) return CSS.supports(rule.conditionText);
    } catch {
      // An unparseable condition is not evidence of anything; keep the group.
    }
    return true;
  };

  const walk = (rules: CSSRuleList, layered: boolean) => {
    for (let i = 0; i < rules.length; i++) {
      const rule = rules.item(i);
      if (rule instanceof CSSConditionRule && !conditionHolds(rule)) continue;
      // Recursion runs before the CSSStyleRule check, not instead of it:
      // @layer and @media wrappers are grouping rules, and under nested CSS so
      // are style rules.
      if (rule instanceof CSSGroupingRule) {
        walk(rule.cssRules, layered || rule instanceof CSSLayerBlockRule);
      }
      if (!(rule instanceof CSSStyleRule)) continue;
      if (declares(rule, ":root")) collect(rule, root, layered);
      else if (declares(rule, ".dark")) collect(rule, dark, layered);
    }
  };

  const sheets = document.styleSheets;
  for (let i = 0; i < sheets.length; i++) {
    try {
      walk(sheets[i].cssRules, false);
    } catch {
      // A cross-origin sheet throws here and holds nothing of ours anyway.
    }
  }

  const vars: Record<string, string> = {};
  for (const prop of Object.keys(dark)) {
    const declaration = root[prop];
    if (declaration) vars[prop] = declaration.value;
  }
  // Custom properties aren't part of React's CSSProperties, hence the cast every
  // var-carrying style object in this repo makes.
  return vars as CSSProperties;
}

// The stage toggle. Owning the theme state here is what lets the scan happen in
// the event handler: a DOM read belongs outside render, the stylesheet is
// certainly loaded by the time anyone clicks, and nothing has to run on the
// server. Re-reading on every switch into light (rather than caching) is
// deliberate — it means a palette author can edit globals.css with the gallery
// open and see the new values by clicking the toggle again.
export function useThemeIsland(): ThemeIsland {
  const [theme, setThemeState] = useState<Theme>("dark");
  const [light, setLight] = useState<CSSProperties | undefined>(undefined);

  const setTheme = (next: Theme) => {
    if (next === "light") setLight(readLightIsland());
    setThemeState(next);
  };

  // Dark needs no variables at all — `.dark` is a plain class selector, so it
  // themes any subtree it is set on. It does have to be set explicitly rather
  // than inherited from <html>: a reviewer can put the whole app in light mode,
  // and a dark island has to stay dark when they do.
  //
  // Starting on dark is what keeps the server render and the hydrating render
  // agreeing by construction — neither carries a style attribute. Should the
  // read ever come back empty (an unreadable stylesheet), the light island
  // renders in the shell's dark tokens: the toggle visibly does nothing, which
  // is the failure this file exists to prefer over a silently stale palette.
  //
  // The light island's `light` class is not styling — nothing in the app
  // declares `.light`. It is the marker globals.css's `dark` variant excludes
  // itself on. Restoring the tokens is only half a light island: the wrapper
  // is still a descendant of html.dark, so without the marker every `dark:`
  // utility in an imported production component (Badge carries three) kept
  // firing, and a reviewer inspecting a light stage saw a component whose
  // tokens said light and whose variant overrides said dark.
  return theme === "dark"
    ? { theme, setTheme, className: "dark", style: undefined }
    : { theme, setTheme, className: "light", style: light };
}

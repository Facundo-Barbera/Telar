"use client";

/**
 * The runtime half of lib/appearance.ts: APPEARANCE_INIT_SCRIPT put the right
 * attributes on <html> before first paint, and this keeps them tracking the
 * store afterwards — a changed accent retints the open window, and a change
 * made in another tab arrives over the `storage` event the store subscribes to.
 */

import { useEffect } from "react";
import { applyAppearance, useAppearance } from "@/lib/appearance";
import { applyBackdrop, useBackdrop } from "@/lib/backdrop";
import { applyThemeCss, useThemeLibrary } from "@/lib/theme-palettes";

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const { appearance } = useAppearance();
  const { backdrop } = useBackdrop();
  const { activeId, themes } = useThemeLibrary();
  useEffect(() => applyAppearance(appearance), [appearance]);
  useEffect(() => applyBackdrop(backdrop), [backdrop]);
  // The theme library writes its compiled stylesheet to localStorage; this
  // keeps the injected <style id="telar-theme"> tracking it after the init
  // script's one shot — on switches AND on edits to the active theme (the
  // hook re-renders for both, and applyThemeCss no-ops when unchanged).
  useEffect(() => applyThemeCss(), [activeId, themes]);
  return children;
}

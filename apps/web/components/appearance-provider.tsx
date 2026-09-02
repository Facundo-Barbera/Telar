"use client";

/**
 * The runtime half of lib/appearance.ts: APPEARANCE_INIT_SCRIPT put the right
 * attributes on <html> before first paint, and this keeps them tracking the
 * store afterwards — a changed accent retints the open window, and a change
 * made in another tab arrives over the `storage` event the store subscribes to.
 */

import { useEffect } from "react";
import { AppearancePublisher } from "@/components/appearance-publisher";
import { applyAppearance, applyWindowChrome, useAppearance } from "@/lib/appearance";
import { applyBackdrop, useBackdrop } from "@/lib/backdrop";
import { isPreviewActive } from "@/lib/studio-preview";
import { applyThemeCss, useThemeLibrary } from "@/lib/theme-palettes";

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const { appearance } = useAppearance();
  const { backdrop } = useBackdrop();
  const { activeId, themes } = useThemeLibrary();
  // While the studio is previewing a draft on the document, the replays stand
  // back: the preview wrote these same surfaces from the draft, and clearing
  // the preview replays the stores itself (lib/studio-preview.ts).
  //
  // EXCEPT THE WINDOW CHROME, which the preview does not own and therefore
  // cannot restore. `translucent` is a property of the machine rather than of
  // the look, so it is replayed unconditionally; without this, toggling
  // Translucency with a draft open rebuilt the window with vibrancy behind an
  // opaque page and appeared to do nothing at all until Apply.
  useEffect(() => {
    if (isPreviewActive()) applyWindowChrome(appearance);
    else applyAppearance(appearance);
  }, [appearance]);
  useEffect(() => {
    if (!isPreviewActive()) applyBackdrop(backdrop);
  }, [backdrop]);
  // The theme library writes its compiled stylesheet to localStorage; this
  // keeps the injected <style id="telar-theme"> tracking it after the init
  // script's one shot — on switches AND on edits to the active theme (the
  // hook re-renders for both, and applyThemeCss no-ops when unchanged).
  // Not gated on the preview: the preview element sits after this one and
  // wins ties, so a stale telar-theme is refreshed harmlessly beneath it.
  useEffect(() => applyThemeCss(), [activeId, themes]);
  // Renders null. It watches the same three stores and tells the engine what
  // this window resolved to, so a paired client can wear the same look — see
  // appearance-publisher.tsx for why a BROWSER is the one that has to say it.
  return (
    <>
      <AppearancePublisher />
      {children}
    </>
  );
}

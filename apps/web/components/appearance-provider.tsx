"use client";

/**
 * The runtime half of lib/appearance.ts: APPEARANCE_INIT_SCRIPT put the right
 * attributes on <html> before first paint, and this keeps them tracking the
 * store afterwards — a changed accent retints the open window, and a change
 * made in another tab arrives over the `storage` event the store subscribes to.
 */

import { useEffect } from "react";
import { applyAppearance, useAppearance } from "@/lib/appearance";

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const { appearance } = useAppearance();
  useEffect(() => applyAppearance(appearance), [appearance]);
  return children;
}

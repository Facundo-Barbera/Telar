"use client";

import { useEffect } from "react";
import { AppearancePublisher } from "./appearance-publisher";
import { HostLookFollower } from "./host-look-follower";
import { applyAppearance, useAppearance } from "../appearance";
import { applyBackdrop, useBackdropCss } from "../backdrop";
import { applyThemeCss, recompileStaleCss, useComposition } from "../composition";

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const { appearance } = useAppearance();
  const { backdrop } = useBackdropCss();
  const { composition } = useComposition();
  useEffect(() => applyAppearance(appearance), [appearance]);
  useEffect(() => applyBackdrop(backdrop), [backdrop]);
  useEffect(() => recompileStaleCss(), []);
  useEffect(() => applyThemeCss(), [composition]);
  return (
    <>
      <AppearancePublisher />
      <HostLookFollower />
      {children}
    </>
  );
}

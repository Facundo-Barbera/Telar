"use client";

import { useEffect } from "react";
import { installNavigationMarks, markNavigation } from "@/platform/perf-marks";

/** Marks when a navigation committed, when its transcript landed, and when it went idle. */
export function useNavigationMarks(pathname: string, transcriptLanded: boolean, loading: boolean) {
  useEffect(() => {
    installNavigationMarks();
    markNavigation("commit", pathname);
  }, [pathname]);
  useEffect(() => {
    if (transcriptLanded) markNavigation("transcript", pathname);
  }, [transcriptLanded, pathname]);
  useEffect(() => {
    if (!loading) markNavigation("idle", pathname);
  }, [loading, pathname]);
}

"use client";

import { useEffect } from "react";
import { createEngineApi } from "@/platform/engine";
import { useAppearance } from "../appearance";
import { decideFollow, readAppliedStamp, useFollowHost, wearPublication, writeAppliedStamp } from "../host-follow";
import { isHostWindow } from "@/lib/host-window";
import { hostVisible, subscribeHostVisibility } from "@/lib/host-visibility";
import { useTheme } from "./theme-provider";

const api = createEngineApi();

const POLL_MS = 10_000;

export function HostLookFollower(): null {
  const { mode } = useFollowHost();
  const { setAppearance } = useAppearance();
  const { setTheme } = useTheme();

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (mode !== "follow" || isHostWindow()) return;

    let live = true;
    let inFlight = false;

    const ask = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const answer = await api.appearance();
        if (!live) return;
        if (decideFollow({ mode: "follow", isHost: false, applied: readAppliedStamp(), answer }) !== "apply") return;
        const published = answer.appearance!;
        wearPublication(published.look, setAppearance);
        setTheme(published.scheme);
        writeAppliedStamp(answer.updatedAt);
      } catch {
      } finally {
        inFlight = false;
      }
    };

    void ask();
    const timer = window.setInterval(() => void ask(), POLL_MS);
    const unsubscribe = subscribeHostVisibility(() => {
      if (hostVisible()) void ask();
    });
    return () => {
      live = false;
      window.clearInterval(timer);
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  return null;
}

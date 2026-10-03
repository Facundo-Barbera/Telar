"use client";

import { useEffect, useState } from "react";

export type EngineRestartNotice = {
  at: number;
  reason: string;
  restarted: boolean;
};

type EngineBridge = {
  lastRestart?: () => Promise<EngineRestartNotice | null>;
  onRestart?: (listener: (notice: EngineRestartNotice) => void) => () => void;
};

function desktopEngine(): EngineBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { telarDesktop?: { engine?: EngineBridge } }).telarDesktop?.engine;
}

export function useEngineRestartNotice(): EngineRestartNotice | undefined {
  const [notice, setNotice] = useState<EngineRestartNotice>();

  useEffect(() => {
    const bridge = desktopEngine();
    if (!bridge?.onRestart) return;
    let live = true;
    void bridge.lastRestart?.().then((seed) => {
      if (live && seed) setNotice((held) => held ?? seed);
    }).catch(() => {
    });
    const stop = bridge.onRestart((next) => {
      if (live) setNotice(next);
    });
    return () => {
      live = false;
      stop();
    };
  }, []);

  return notice;
}

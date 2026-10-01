import type { EventLoopHealth, EventLoopStall } from "@telar/engine-client";

type LoopLagOptions = {
  thresholdMs?: number;
  intervalMs?: number;
  now?: () => number;
  warn?: (line: string) => void;
};

const KEPT_STALLS = 20;

export function createLoopLag(options: LoopLagOptions = {}) {
  const thresholdMs = options.thresholdMs ?? 500;
  const intervalMs = options.intervalMs ?? 100;
  const now = options.now ?? (() => performance.now());
  const warn = options.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const stalls: EventLoopStall[] = [];
  let worst: { operation: string; ms: number } | undefined;
  let maxLagMs = 0;
  let last = now();
  let timer: ReturnType<typeof setInterval> | undefined;

  const tick = () => {
    const at = now();
    const lagMs = Math.max(0, Math.round(at - last - intervalMs));
    last = at;
    maxLagMs = Math.max(maxLagMs, lagMs);
    if (lagMs >= thresholdMs) {
      const operation = worst?.operation ?? "unlabelled";
      stalls.push({ at: Date.now(), lagMs, operation });
      if (stalls.length > KEPT_STALLS) stalls.shift();
      warn(`Telar engine: the event loop stalled ${lagMs} ms during ${operation}`);
    }
    worst = undefined;
  };

  return {
    tick,
    run<T>(operation: string, section: () => T): T {
      const startedAt = now();
      try {
        return section();
      } finally {
        const ms = now() - startedAt;
        if (!worst || ms > worst.ms) worst = { operation, ms };
      }
    },
    start() {
      if (timer) return;
      last = now();
      timer = setInterval(tick, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    health(): EventLoopHealth {
      return { thresholdMs, maxLagMs, stalls: [...stalls] };
    },
  };
}

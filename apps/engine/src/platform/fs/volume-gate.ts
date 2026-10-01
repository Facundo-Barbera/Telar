import fsp from "node:fs/promises";
import path from "node:path";
import { mountPointForRoot } from "./volumes";

export type VolumeHealth = "ok" | "slow" | "missing";
export type VolumeProbe = (mount: string) => Promise<VolumeHealth>;

const PROBE_TIMEOUT_MS = 2_000;
const OP_TIMEOUT_MS = 10_000;

class FsTimeout extends Error {}

/** Rejects with `FsTimeout` after `ms`; the work is aborted, but an fs call already in the thread pool runs on. */
async function within<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new FsTimeout(`no answer in ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The volume a path lives on: its mount under a mount root, or the filesystem root. */
export const volumeOf = (target: string): string => mountPointForRoot(target) ?? path.parse(path.resolve(target)).root;

export async function probeVolume(mount: string, stat: (target: string) => Promise<{ dev: number }> = fsp.stat): Promise<VolumeHealth> {
  try {
    const parent = path.dirname(mount);
    const [here, above] = await within(PROBE_TIMEOUT_MS, () => Promise.all([stat(mount), stat(parent)]));
    return parent === mount || here.dev !== above.dev ? "ok" : "missing";
  } catch (error) {
    return error instanceof FsTimeout ? "slow" : "missing";
  }
}

export async function eachBounded<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/**
 * Fs work on checkouts, one volume at a time: each distinct volume is probed once, and a volume that is slow or
 * missing, or that lets any one call time out, is skipped from then on.
 */
export class VolumeGate {
  readonly degraded = new Map<string, Exclude<VolumeHealth, "ok">>();

  constructor(private readonly probe: VolumeProbe = probeVolume) {}

  async admit(paths: readonly string[]): Promise<void> {
    const volumes = [...new Set(paths.map(volumeOf))].filter((volume) => !this.degraded.has(volume));
    await Promise.all(
      volumes.map(async (volume) => {
        const health = await this.probe(volume);
        if (health !== "ok") this.degraded.set(volume, health);
      }),
    );
  }

  /** Probes the degraded volumes again, so one that came back is used again. */
  async recheck(): Promise<void> {
    const volumes = [...this.degraded.keys()];
    await Promise.all(
      volumes.map(async (volume) => {
        if ((await this.probe(volume)) === "ok") this.degraded.delete(volume);
      }),
    );
  }

  open(target: string): boolean {
    return !this.degraded.has(volumeOf(target));
  }

  /** `undefined` when the volume is degraded, the call throws, or it outlives `ms`. */
  async run<T>(target: string, work: (signal: AbortSignal) => Promise<T>, ms = OP_TIMEOUT_MS): Promise<T | undefined> {
    if (!this.open(target)) return undefined;
    try {
      return await within(ms, work);
    } catch (error) {
      if (error instanceof FsTimeout) this.degraded.set(volumeOf(target), "slow");
      return undefined;
    }
  }
}

export const existsWithin = (gate: VolumeGate, target: string): Promise<boolean> =>
  gate.run(target, () => fsp.access(target).then(() => true, () => false)).then((found) => found === true);

import fs from "node:fs";
import path from "node:path";
import { privateBytes } from "../../platform/fs/private-size";
import { mountPointForRoot } from "../../platform/fs/volumes";
import { bytesOf, type CheckoutFigure } from "./measure";

export type SizingStat = Pick<fs.Stats, "blocks" | "size" | "nlink" | "dev" | "ino" | "mtimeMs"> & { isDirectory(): boolean };

export type SizingFs = {
  lstat(target: string): Promise<SizingStat>;
  readdir(target: string): Promise<string[]>;
  privateSize?(target: string): number | undefined;
};

export type CheckoutSizesOptions = {
  fs?: SizingFs;
  now?: () => number;
  schedule?: (next: () => void) => { cancel(): void };
  gapMs?: number;
  concurrency?: number;
  opsPerPass?: number;
  msPerPass?: number;
  idleMs?: number;
  ttlMs?: number;
  opTimeoutMs?: number;
  /** The checkouts of live sessions; only these are walked. Absent walks every checkout. */
  live?: () => ReadonlySet<string>;
};

const nodeFs: SizingFs = {
  lstat: (target) => fs.promises.lstat(target),
  readdir: (target) => fs.promises.readdir(target),
  privateSize: privateBytes,
};

const LIVE_TTL_MS = 5_000;

class VolumeTimeout extends Error {}

function volumeOf(target: string): string {
  return mountPointForRoot(target) ?? path.parse(target).root;
}

type Walk = { bytes: number; partial: boolean; dirs: string[]; pending: string[]; seen: Set<string>; stamp: number };
type Settled = { bytes: number; partial: boolean; at: number; stamp: number; stale: boolean };
type Checkout = { settled?: Settled; walk?: Walk; stamp: number; adopted: boolean };

export class CheckoutSizes {
  private readonly fs: SizingFs;
  private readonly now: () => number;
  private readonly schedule: (next: () => void) => { cancel(): void };
  private readonly concurrency: number;
  private readonly opsPerPass: number;
  private readonly msPerPass: number;
  private readonly idleMs: number;
  private readonly ttlMs: number;
  private readonly opTimeoutMs: number;
  private readonly liveOf: (() => ReadonlySet<string>) | undefined;
  private live: { at: number; paths: ReadonlySet<string> } | undefined;
  private readonly degraded = new Set<string>();

  private readonly checkouts = new Map<string, Checkout>();
  private loose = { bytes: 0, partial: false };
  private roots: string[] = [];
  private listedAt: number | undefined;
  private lastDemand = Number.NEGATIVE_INFINITY;
  private pending: { cancel(): void } | undefined;
  private running = false;
  private stopped = false;

  readonly stats = { ops: 0, passes: 0, idleStops: 0 };

  constructor(options: CheckoutSizesOptions = {}) {
    this.fs = options.fs ?? nodeFs;
    this.now = options.now ?? Date.now;
    const gapMs = options.gapMs ?? 25;
    this.schedule =
      options.schedule ??
      ((next) => {
        const timer = setTimeout(next, gapMs);
        timer.unref?.();
        return { cancel: () => clearTimeout(timer) };
      });
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.opsPerPass = Math.max(1, options.opsPerPass ?? 2_000);
    this.msPerPass = options.msPerPass ?? 50;
    this.idleMs = options.idleMs ?? 15_000;
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.opTimeoutMs = options.opTimeoutMs ?? 10_000;
    this.liveOf = options.live;
  }

  figure(roots: readonly string[]): CheckoutFigure {
    this.want(roots);
    let bytes = this.loose.bytes;
    let partial = this.loose.partial;
    let measured = 0;
    const counted = this.inRoots();
    for (const [key, checkout] of counted) {
      const shown = checkout.settled ?? checkout.walk;
      bytes += shown?.bytes ?? 0;
      partial ||= (shown?.partial ?? false) || this.degraded.has(volumeOf(key));
      if (!this.due(checkout, key)) measured += 1;
    }
    const of = counted.length;
    const measuring = this.listedAt === undefined || measured < of;
    return { bytes, partial, measuring, measured, of };
  }

  peek(target: string, roots: readonly string[]): { bytes?: number; partial: boolean } {
    const key = path.resolve(target);
    if (!this.checkouts.has(key) && this.isLive(key)) this.checkouts.set(key, { stamp: 0, adopted: true });
    this.want(roots);
    const settled = this.checkouts.get(key)?.settled;
    return settled ? { bytes: settled.bytes, partial: settled.partial } : { partial: false };
  }

  known(target: string): number | undefined {
    return this.checkouts.get(path.resolve(target))?.settled?.bytes;
  }

  invalidate(): void {
    for (const checkout of this.checkouts.values()) if (checkout.settled) checkout.settled.stale = true;
    this.degraded.clear();
    this.relist();
  }

  relist(): void {
    this.listedAt = undefined;
    this.live = undefined;
  }

  stop(): void {
    this.stopped = true;
    this.pending?.cancel();
    this.pending = undefined;
    this.running = false;
  }

  private want(roots: readonly string[]): void {
    const resolved = [...new Set(roots.map((root) => path.resolve(root)))];
    if (resolved.join("\0") !== this.roots.join("\0")) {
      this.roots = resolved;
      this.relist();
    }
    this.lastDemand = this.now();
    if (this.stopped || this.running) return;
    if (this.needsListing() || [...this.checkouts].some(([key, checkout]) => this.due(checkout, key))) {
      this.running = true;
      this.pending = this.schedule(() => void this.tick());
    }
  }

  private inRoots(): Array<[string, Checkout]> {
    return [...this.checkouts.entries()].filter(([key, checkout]) => !checkout.adopted && this.roots.includes(path.dirname(key)));
  }

  private needsListing(): boolean {
    return this.listedAt === undefined;
  }

  private isLive(key: string): boolean {
    if (!this.liveOf) return true;
    if (!this.live || this.now() - this.live.at > LIVE_TTL_MS) this.live = { at: this.now(), paths: new Set([...this.liveOf()].map((live) => path.resolve(live))) };
    return this.live.paths.has(key);
  }

  private timed<T>(target: string, work: Promise<T>): Promise<T> {
    const volume = volumeOf(target);
    if (this.degraded.has(volume)) return Promise.reject(new VolumeTimeout(volume));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.degraded.add(volume);
        reject(new VolumeTimeout(volume));
      }, this.opTimeoutMs);
      timer.unref?.();
    });
    return Promise.race([work, expired]).finally(() => clearTimeout(timer));
  }

  private lstat(target: string): Promise<SizingStat> {
    return this.timed(target, this.fs.lstat(target));
  }

  private readdir(target: string): Promise<string[]> {
    return this.timed(target, this.fs.readdir(target));
  }

  private due(checkout: Checkout, key?: string): boolean {
    if (key !== undefined && this.degraded.has(volumeOf(key))) return false;
    if (checkout.walk) return true;
    const settled = checkout.settled;
    if (!settled) return true;
    return settled.stale || settled.stamp !== checkout.stamp || this.now() - settled.at > this.ttlMs;
  }

  private async tick(): Promise<void> {
    this.pending = undefined;
    if (this.stopped || this.now() - this.lastDemand > this.idleMs) {
      if (!this.stopped) this.stats.idleStops += 1;
      this.running = false;
      return;
    }
    let more = false;
    try {
      more = await this.pass();
    } catch {
      more = false;
    } finally {
      this.stats.passes += 1;
      if (more && !this.stopped) this.pending = this.schedule(() => void this.tick());
      else this.running = false;
    }
  }

  private async pass(): Promise<boolean> {
    let ops = this.opsPerPass;
    const until = this.now() + this.msPerPass;
    const spend = () => {
      ops -= 1;
      this.stats.ops += 1;
    };
    const exhausted = () => this.stopped || ops <= 0 || this.now() >= until;

    if (this.needsListing()) await this.list(spend);
    for (const [key, checkout] of this.checkouts) {
      if (exhausted()) break;
      if (this.due(checkout, key)) await this.advance(key, checkout, spend, exhausted, () => ops);
    }
    return this.needsListing() || [...this.checkouts].some(([key, checkout]) => this.due(checkout, key));
  }

  private async list(spend: () => void): Promise<void> {
    const present = new Set<string>();
    const loose = { bytes: 0, partial: false };
    for (const root of this.roots) {
      spend();
      let names: string[];
      try {
        names = await this.readdir(root);
      } catch (error) {
        if (error instanceof VolumeTimeout) loose.partial = true;
        continue;
      }
      try {
        spend();
        loose.bytes += bytesOf(await this.lstat(root));
      } catch {
        loose.partial = true;
      }
      for (const name of names) {
        const target = path.join(root, name);
        if (!this.isLive(target)) {
          loose.partial ||= !name.startsWith(".");
          continue;
        }
        spend();
        let stat: SizingStat;
        try {
          stat = await this.lstat(target);
        } catch {
          loose.partial = true;
          continue;
        }
        if (!stat.isDirectory()) {
          loose.bytes += bytesOf(stat);
          continue;
        }
        present.add(target);
        const checkout = this.checkouts.get(target);
        if (checkout) {
          checkout.stamp = stat.mtimeMs;
          checkout.adopted = false;
        } else this.checkouts.set(target, { stamp: stat.mtimeMs, adopted: false });
      }
    }
    for (const [key, checkout] of this.checkouts) {
      if (present.has(key)) continue;
      if (!checkout.adopted) {
        this.checkouts.delete(key);
        continue;
      }
      spend();
      try {
        checkout.stamp = (await this.lstat(key)).mtimeMs;
      } catch {
        this.checkouts.delete(key);
      }
    }
    this.loose = loose;
    this.listedAt = this.now();
  }

  private async advance(key: string, checkout: Checkout, spend: () => void, exhausted: () => boolean, left: () => number): Promise<void> {
    checkout.walk ??= { bytes: 0, partial: false, dirs: [], pending: [key], seen: new Set(), stamp: checkout.stamp };
    const walk = checkout.walk;
    while (!exhausted()) {
      if (walk.pending.length > 0) {
        const batch = walk.pending.splice(Math.max(0, walk.pending.length - Math.min(this.concurrency, left())));
        const stats = await Promise.all(
          batch.map(async (target) => {
            spend();
            try {
              return { target, stat: await this.lstat(target) };
            } catch {
              return { target, stat: undefined };
            }
          }),
        );
        for (const { target, stat } of stats) {
          if (!stat) {
            walk.partial = true;
            continue;
          }
          if (stat.isDirectory()) {
            if (path.basename(target) !== "node_modules") walk.dirs.push(target);
            walk.bytes += bytesOf(stat);
            continue;
          }
          if (stat.nlink > 1) {
            const inode = `${stat.dev}:${stat.ino}`;
            if (walk.seen.has(inode)) continue;
            walk.seen.add(inode);
          }
          walk.bytes += this.fs.privateSize?.(target) ?? bytesOf(stat);
        }
        continue;
      }
      const dir = walk.dirs.pop();
      if (dir === undefined) {
        checkout.settled = { bytes: walk.bytes, partial: walk.partial, at: this.now(), stamp: walk.stamp, stale: false };
        checkout.walk = undefined;
        return;
      }
      spend();
      try {
        for (const name of await this.readdir(dir)) walk.pending.push(path.join(dir, name));
      } catch {
        walk.partial = true;
      }
    }
  }
}

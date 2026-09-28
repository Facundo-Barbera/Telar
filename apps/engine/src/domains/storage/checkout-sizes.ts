/**
 * ══ HOW BIG EACH SESSION CHECKOUT IS, MEASURED OFF THE REQUEST PATH ══
 *
 * WHY THIS EXISTS. `/v2/storage` used to walk every checkout file by file
 * before answering: on the machine this was found on, ~140 checkouts of ~75k
 * files each on a busy HDD — millions of `lstat`s. Async did not save it: each
 * one is a job on libuv's thread pool (four threads by default), the same pool
 * every other `fs.promises` call in the engine queues on, so the whole engine
 * slowed behind a pane nobody could see finish. And the cockpit's two read
 * slots stayed pinned on requests that never returned, so the sidebar and every
 * conversation queued behind them until a reload.
 *
 * THE SHAPE, AND WHY EACH PART:
 *  - ONE WALKER, at most `concurrency` (default 2) filesystem calls in flight,
 *    so it can never occupy more than half the pool.
 *  - A BUDGET PER PASS — operations and milliseconds — then a yield to the
 *    event loop before the next pass. A walk is resumable: its frontier is kept,
 *    so a pass stops mid-directory and the next one carries on.
 *  - A FIGURE PER CHECKOUT, cached. Re-measured when the checkout directory's
 *    own mtime moves, when it is older than `ttlMs`, or when somebody presses
 *    refresh — and the old figure is served until the new one settles.
 *  - WORK ONLY WHILE SOMEBODY IS WAITING. Every read `demand`s; with no demand
 *    for `idleMs` the job stops where it stands (progress kept) and resumes on
 *    the next read. The pane polls while a row says `measuring`, which is what
 *    keeps it going — close the pane and the disk goes quiet.
 *
 * THE MEASUREMENT RULE IS `storage.ts`'s: allocated blocks, `lstat` so no
 * symlink is followed, hard links counted once — per checkout, the same as
 * `measureDirectory` did for the inventory rows.
 */

import fs from "node:fs";
import path from "node:path";
import { bytesOf, type CheckoutFigure } from "./storage";

export type SizingStat = Pick<fs.Stats, "blocks" | "size" | "nlink" | "dev" | "ino" | "mtimeMs"> & { isDirectory(): boolean };

/** The two calls the walker makes. A seam so a test can hand it a tree of a
 *  million files that does not exist, and count what it was asked. */
export type SizingFs = {
  lstat(target: string): Promise<SizingStat>;
  readdir(target: string): Promise<string[]>;
};

export type CheckoutSizesOptions = {
  fs?: SizingFs;
  now?: () => number;
  /** How the next pass is queued. Default: an unref'd timer `gapMs` out, so
   *  other I/O gets the pool between passes. */
  schedule?: (next: () => void) => { cancel(): void };
  gapMs?: number;
  concurrency?: number;
  opsPerPass?: number;
  msPerPass?: number;
  idleMs?: number;
  ttlMs?: number;
  /** How often the roots are re-listed for new, gone or touched checkouts. */
  relistMs?: number;
};

const nodeFs: SizingFs = {
  lstat: (target) => fs.promises.lstat(target),
  readdir: (target) => fs.promises.readdir(target),
};

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
  private readonly relistMs: number;

  private readonly checkouts = new Map<string, Checkout>();
  /** The roots themselves and the loose files directly in them. */
  private loose = { bytes: 0, partial: false };
  private roots: string[] = [];
  private listedAt: number | undefined;
  private lastDemand = Number.NEGATIVE_INFINITY;
  private pending: { cancel(): void } | undefined;
  private running = false;
  private stopped = false;

  /** Observability for tests and diagnosis: filesystem calls made, passes
   *  run, and times the job stopped because nobody was asking any more. */
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
    this.relistMs = options.relistMs ?? 30_000;
  }

  /**
   * THE CHECKOUTS ROW, FROM MEMORY — never a walk. Records that somebody is
   * waiting and starts the job if there is anything to do.
   */
  figure(roots: readonly string[]): CheckoutFigure {
    this.want(roots);
    let bytes = this.loose.bytes;
    let partial = this.loose.partial;
    let measured = 0;
    const counted = this.inRoots();
    for (const checkout of counted) {
      // The last settled figure while a re-measure runs; a floor before one.
      const shown = checkout.settled ?? checkout.walk;
      bytes += shown?.bytes ?? 0;
      partial ||= shown?.partial ?? false;
      if (!this.due(checkout)) measured += 1;
    }
    const of = counted.length;
    const measuring = this.listedAt === undefined || measured < of;
    return { bytes, partial, measuring, measured, of };
  }

  /**
   * ONE CHECKOUT'S SETTLED SIZE, or no `bytes` while it has none. A checkout
   * outside the roots (cut before a move) is adopted so it gets measured too.
   */
  peek(target: string, roots: readonly string[]): { bytes?: number; partial: boolean } {
    const key = path.resolve(target);
    if (!this.checkouts.has(key)) this.checkouts.set(key, { stamp: 0, adopted: true });
    this.want(roots);
    const settled = this.checkouts.get(key)?.settled;
    return settled ? { bytes: settled.bytes, partial: settled.partial } : { partial: false };
  }

  /** Refresh: every figure is re-measured, and served until the new one settles. */
  invalidate(): void {
    for (const checkout of this.checkouts.values()) if (checkout.settled) checkout.settled.stale = true;
    this.listedAt = undefined;
  }

  /** Checkouts were cut, moved or given back: re-list the roots on the next
   *  pass, without re-measuring the ones that did not change. */
  relist(): void {
    this.listedAt = undefined;
  }

  /** Stop for good — the daemon is closing. */
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
      this.listedAt = undefined;
    }
    this.lastDemand = this.now();
    if (this.stopped || this.running) return;
    if (this.needsListing() || [...this.checkouts.values()].some((checkout) => this.due(checkout))) {
      this.running = true;
      this.pending = this.schedule(() => void this.tick());
    }
  }

  /** The checkouts the storage row counts: the roots' own children. One the
   *  inventory adopted from elsewhere is sized for its row, not summed here. */
  private inRoots(): Checkout[] {
    return [...this.checkouts.entries()].filter(([key, checkout]) => !checkout.adopted && this.roots.includes(path.dirname(key))).map(([, checkout]) => checkout);
  }

  private needsListing(): boolean {
    return this.listedAt === undefined || this.now() - this.listedAt > this.relistMs;
  }

  private due(checkout: Checkout): boolean {
    if (checkout.walk) return true;
    const settled = checkout.settled;
    if (!settled) return true;
    return settled.stale || settled.stamp !== checkout.stamp || this.now() - settled.at > this.ttlMs;
  }

  private async tick(): Promise<void> {
    this.pending = undefined;
    // NOBODY WAITING: stop where we stand. The frontier is kept, so the next
    // read resumes the walk instead of restarting it.
    if (this.stopped || this.now() - this.lastDemand > this.idleMs) {
      if (!this.stopped) this.stats.idleStops += 1;
      this.running = false;
      return;
    }
    let more = false;
    try {
      more = await this.pass();
    } catch {
      // Every filesystem call above records its own failure as `partial`; a
      // throw here is a bug, and it must not become an unhandled rejection.
      more = false;
    } finally {
      this.stats.passes += 1;
      if (more && !this.stopped) this.pending = this.schedule(() => void this.tick());
      else this.running = false;
    }
  }

  /** One budgeted pass. True when there is work left. */
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
      if (this.due(checkout)) await this.advance(key, checkout, spend, exhausted, () => ops);
    }
    return this.needsListing() || [...this.checkouts.values()].some((checkout) => this.due(checkout));
  }

  /**
   * THE ROOTS, ONE `readdir` EACH AND ONE `lstat` PER CHILD — cuts are flat at
   * `<root>/<name>-<8hex>`, so this is the whole scan. A child's mtime is its
   * stamp; a checkout that has gone is forgotten.
   */
  private async list(spend: () => void): Promise<void> {
    const present = new Set<string>();
    const loose = { bytes: 0, partial: false };
    for (const root of this.roots) {
      spend();
      let names: string[];
      try {
        names = await this.fs.readdir(root);
      } catch {
        continue; // An absent root is zero checkouts, not a partial read.
      }
      try {
        spend();
        loose.bytes += bytesOf(await this.fs.lstat(root));
      } catch {
        loose.partial = true;
      }
      for (const name of names) {
        const target = path.join(root, name);
        spend();
        let stat: SizingStat;
        try {
          stat = await this.fs.lstat(target);
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
        checkout.stamp = (await this.fs.lstat(key)).mtimeMs;
      } catch {
        this.checkouts.delete(key);
      }
    }
    this.loose = loose;
    this.listedAt = this.now();
  }

  /** Carry one checkout's walk forward until it settles or the budget runs out. */
  private async advance(key: string, checkout: Checkout, spend: () => void, exhausted: () => boolean, left: () => number): Promise<void> {
    checkout.walk ??= { bytes: 0, partial: false, dirs: [], pending: [key], seen: new Set(), stamp: checkout.stamp };
    const walk = checkout.walk;
    while (!exhausted()) {
      if (walk.pending.length > 0) {
        // `pop`, not `shift`: order does not matter to a sum, and a directory
        // of 50k entries would make `shift` quadratic.
        const batch = walk.pending.splice(Math.max(0, walk.pending.length - Math.min(this.concurrency, left())));
        const stats = await Promise.all(
          batch.map(async (target) => {
            spend();
            try {
              return { target, stat: await this.fs.lstat(target) };
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
            walk.dirs.push(target);
            walk.bytes += bytesOf(stat);
            continue;
          }
          if (stat.nlink > 1) {
            const inode = `${stat.dev}:${stat.ino}`;
            if (walk.seen.has(inode)) continue;
            walk.seen.add(inode);
          }
          walk.bytes += bytesOf(stat);
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
        for (const name of await this.fs.readdir(dir)) walk.pending.push(path.join(dir, name));
      } catch {
        walk.partial = true;
      }
    }
  }
}

import type { StorageReport } from "@telar/engine-client";
import { HttpError } from "../../platform/http/http";
import { ok, type Route } from "../../platform/http/route";
import type { EngineStore } from "../../state";
import { defaultWorktreesRoot, readWorktreesRoot, rootOf } from "../../worktrees-location";
import { checkoutRootsOf, measureStore, withCheckouts } from "./measure";

export type StorageMeter = {
  read(refresh: boolean): Promise<StorageReport>;
  /** The store figure is stale; the next read walks again. */
  forget(): void;
  /** Checkouts were cut, moved or given back: also re-list them for the background sizer. */
  checkoutsChanged(): void;
};

/** Measured lazily, one walk at a time; checkouts are sized in the background and folded in on every read. */
export function createStorageMeter(store: EngineStore): StorageMeter {
  const cache: { report?: StorageReport; inFlight?: Promise<StorageReport> } = {};
  // While a root change lasts, checkouts sit under both roots and both count.
  const roots = () => {
    const fallback = defaultWorktreesRoot(store.paths.root);
    const configured = rootOf(readWorktreesRoot(store.paths.root)) ?? fallback;
    return { configured, also: configured === fallback ? [] : [fallback] };
  };
  return {
    async read(refresh) {
      const { configured, also } = roots();
      if (refresh) store.checkoutSizes.invalidate();
      let report = cache.report;
      if (refresh || !report) {
        cache.inFlight ??= measureStore({ root: store.paths.root, worktreesRoot: configured, alsoWorktrees: also })
          .then((measured) => (cache.report = measured))
          .finally(() => (cache.inFlight = undefined));
        report = await cache.inFlight;
      }
      return withCheckouts(report, store.checkoutSizes.figure(checkoutRootsOf({ worktreesRoot: configured, alsoWorktrees: also })), configured);
    },
    forget: () => (cache.report = undefined),
    checkoutsChanged() {
      cache.report = undefined;
      store.checkoutSizes.relist();
    },
  };
}

export function storageRoutes(store: EngineStore, meter: StorageMeter): Route[] {
  const cleanup = () => ({
    cleanup: { policy: store.cleanup.policy(), ...(store.cleanup.last() ? { last: store.cleanup.last() } : {}), running: store.isCleanupRunning() },
  });
  return [
    { method: "GET", path: "/v2/storage", auth: "engine", handle: async ({ query }) => ok({ storage: await meter.read(query.get("refresh") === "1") }) },
    {
      method: "POST",
      path: "/v2/storage/journal/reclaim",
      auth: "engine",
      handle() {
        const reclaimed = store.reclaimExecutionStore();
        if (!reclaimed) return { status: 409, body: { error: "this engine is not running on SQLite, so there is nothing to vacuum" } };
        meter.forget();
        return ok({ reclaimed });
      },
    },
    {
      method: "POST",
      path: "/v2/storage/copy",
      auth: "engine",
      handle({ body }) {
        if (typeof body.destination !== "string" || !body.destination.trim()) throw new HttpError(400, "invalid_request", "name a folder for Telar to create the copy in");
        return ok({ copy: store.copyStoreTo(body.destination.trim()) });
      },
    },
    {
      method: "GET",
      path: "/v2/storage/retention",
      auth: "engine",
      handle: ({ query }) => ok({ retention: store.getRetentionPolicy(), buckets: store.retentionPreview(query.get("bytes") === "1" ? { bytes: true } : {}) }),
    },
    { method: "PUT", path: "/v2/storage/retention", auth: "engine", handle: ({ body }) => ok({ retention: store.setRetentionPolicy(body) }) },
    {
      method: "POST",
      path: "/v2/storage/retention/sweep",
      auth: "engine",
      handle() {
        const swept = store.sweepRetention();
        meter.forget();
        return ok({ swept });
      },
    },
    { method: "GET", path: "/v2/cleanup", auth: "engine", handle: () => ok(cleanup()) },
    {
      method: "PUT",
      path: "/v2/cleanup",
      auth: "engine",
      handle({ body }) {
        if (!store.cleanup.setPolicy(body)) throw new HttpError(400, "invalid_request", "inactive days must be 3, 7, 14 or 30; log days 7 or 30; the others true or false");
        return ok(cleanup());
      },
    },
    {
      method: "POST",
      path: "/v2/cleanup/run",
      auth: "engine",
      async handle() {
        await store.runCleanup();
        meter.forget();
        return ok(cleanup());
      },
    },
  ];
}

import type { EngineTransport } from "../platform/transport";
import type { JournalReclaim, JournalRetirement, RetentionBucket, RetentionPolicy, StorageReport, StoreCopy } from "./schema";

export const storageClient = {
  storage(this: EngineTransport, options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<{ storage: StorageReport }> {
    return this.request("GET", `/v2/storage${options.refresh ? "?refresh=1" : ""}`, undefined, options.signal);
  },

  reclaimJournal(this: EngineTransport): Promise<{ reclaimed: JournalReclaim }> {
    return this.request("POST", "/v2/storage/journal/reclaim");
  },

  copyStore(this: EngineTransport, destination: string): Promise<{ copy: StoreCopy }> {
    return this.request("POST", "/v2/storage/copy", { destination });
  },

  retention(
    this: EngineTransport,
    options: { bytes?: boolean; signal?: AbortSignal } = {},
  ): Promise<{ retention: RetentionPolicy; buckets: RetentionBucket[] }> {
    return this.request("GET", `/v2/storage/retention${options.bytes ? "?bytes=1" : ""}`, undefined, options.signal);
  },

  /** A window with no export destination is refused: the copy comes before the delete. */
  setRetention(this: EngineTransport, patch: { idleAfterDays?: number | null; exportTo?: string | null }): Promise<{ retention: RetentionPolicy }> {
    return this.request("PUT", "/v2/storage/retention", patch);
  },

  sweepRetention(this: EngineTransport): Promise<{ swept: JournalRetirement }> {
    return this.request("POST", "/v2/storage/retention/sweep");
  },
};

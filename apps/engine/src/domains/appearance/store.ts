import fs from "node:fs";
import { EngineStateError, STATE_VERSION, type Kernel } from "../../platform/kernel";

const MAX_APPEARANCE_BYTES = 8 * 1024 * 1024;

type Published = { updatedAt: number; blob: Record<string, unknown> };

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The host's resolved look, republished by a browser for paired clients. An
 * opaque JSON object the engine never inspects, so the cockpit's vocabulary
 * grows without engine releases; only its shape and size are enforced.
 */
export class AppearanceStore {
  constructor(private readonly kernel: Kernel) {}

  /** `null` when nothing is published or the file is unreadable. A file from before the stamp reads as epoch 0. */
  get(): Published | null {
    try {
      const stored = this.kernel.readDocument(this.kernel.paths.appearance) as { appearance?: unknown; updatedAt?: unknown } | undefined;
      const blob = stored?.appearance;
      if (!isPlainJsonObject(blob)) return null;
      return { updatedAt: typeof stored?.updatedAt === "number" && Number.isFinite(stored.updatedAt) ? stored.updatedAt : 0, blob };
    } catch {
      return null;
    }
  }

  /** Replaces the blob wholesale, stamped with the engine's clock so the ETag never goes backwards. */
  set(blob: unknown): Published {
    if (!isPlainJsonObject(blob)) throw new EngineStateError("invalid_request", "appearance must be a JSON object");
    let serialized: string;
    try {
      serialized = JSON.stringify(blob);
    } catch {
      throw new EngineStateError("invalid_request", "appearance must be JSON-serializable");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_APPEARANCE_BYTES) {
      throw new EngineStateError("invalid_request", `appearance must be under ${MAX_APPEARANCE_BYTES} bytes when serialized`);
    }
    const updatedAt = Date.now();
    this.kernel.writeDocument(this.kernel.paths.appearance, { version: STATE_VERSION, updatedAt, appearance: blob });
    return { updatedAt, blob };
  }

  /** Idempotent; removing the file keeps `null` the one meaning of "nothing published". */
  clear(): void {
    try {
      fs.rmSync(this.kernel.paths.appearance, { force: true });
    } catch {
      // A file that can't be deleted leaves a look published; not worth failing the request.
    }
  }
}

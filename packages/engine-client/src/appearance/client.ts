import type { EngineTransport } from "../platform/transport";
import { parsePublishedAppearance, type PublishedAppearance } from "./schema";

type Entry = Record<string, unknown>;

const isEntry = (value: unknown): value is Entry => typeof value === "object" && value !== null && !Array.isArray(value);
const entries = (value: unknown): Entry[] => (Array.isArray(value) ? value.filter(isEntry) : []);

export const appearanceClient = {
  async appearance(this: EngineTransport): Promise<{ appearance: PublishedAppearance | null; updatedAt: number | null }> {
    const raw = await this.request<{ appearance?: unknown; updatedAt?: unknown }>("GET", "/v2/appearance");
    return {
      appearance: parsePublishedAppearance(raw.appearance) ?? null,
      updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : null,
    };
  },

  async appearanceHome(this: EngineTransport): Promise<{
    settings: Entry | null;
    themes: Entry[];
    looks: Entry[];
    images: string[];
    skipped: { file: string; reason: string }[];
  }> {
    const raw = await this.request<Entry>("GET", "/v2/appearance/home");
    return {
      settings: isEntry(raw["settings"]) ? raw["settings"] : null,
      themes: entries(raw["themes"]),
      looks: entries(raw["looks"]),
      images: Array.isArray(raw["images"]) ? raw["images"].filter((name): name is string => typeof name === "string") : [],
      skipped: entries(raw["skipped"]).map((entry) => ({ file: String(entry["file"] ?? ""), reason: String(entry["reason"] ?? "") })),
    };
  },

  appearanceImage(this: EngineTransport, name: string): Promise<{ data: Uint8Array; contentType: string }> {
    return this.readBytes(`/v2/appearance/home/images/${encodeURIComponent(name)}`);
  },

  setAppearance(this: EngineTransport, blob: PublishedAppearance): Promise<{ ok: boolean; updatedAt: number; etag: string }> {
    return this.request("PUT", "/v2/appearance", blob);
  },

  /** Idempotent: clearing when nothing is published is still a 200. */
  clearAppearance(this: EngineTransport): Promise<{ ok: boolean }> {
    return this.request("DELETE", "/v2/appearance");
  },
};

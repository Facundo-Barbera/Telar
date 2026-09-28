import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const EDGE_PX = 128;
const TIMEOUT_MS = 5_000;
const EXTERNAL_REFERENCE = /(?:xlink:)?href\s*=\s*["'](?!#|data:)/i;

export type Rasterize = (input: string, output: string, edge: number) => Promise<void>;

const sips: Rasterize = (input, output, edge) =>
  new Promise((resolve, reject) => {
    execFile("/usr/bin/sips", ["-s", "format", "png", "-Z", String(edge), input, "--out", output], { timeout: TIMEOUT_MS }, (error) =>
      error ? reject(error) : resolve(),
    );
  });

/** Turns served icon bytes into a PNG a phone can decode, cached on disk by content hash. */
export function createIconPng(cacheDir: string, rasterize: Rasterize = sips) {
  const pending = new Map<string, Promise<Buffer | undefined>>();

  async function render(bytes: Buffer, hash: string): Promise<Buffer | undefined> {
    const output = path.join(cacheDir, `${hash}.png`);
    const cached = await fs.readFile(output).catch(() => undefined);
    if (cached) return cached;
    if (EXTERNAL_REFERENCE.test(bytes.toString("utf8"))) return undefined;
    await fs.mkdir(cacheDir, { recursive: true });
    const input = path.join(cacheDir, `${hash}.${crypto.randomUUID()}.svg`);
    const staged = `${output}.${crypto.randomUUID()}.tmp.png`;
    try {
      await fs.writeFile(input, bytes);
      await rasterize(input, staged, EDGE_PX);
      await fs.rename(staged, output);
      return await fs.readFile(output);
    } catch {
      return undefined;
    } finally {
      await fs.rm(input, { force: true });
      await fs.rm(staged, { force: true });
    }
  }

  return async function iconPng(icon: { bytes: Buffer; contentType: string }): Promise<Buffer | undefined> {
    if (icon.contentType !== "image/svg+xml") return icon.bytes;
    const hash = crypto.createHash("sha256").update(icon.bytes).digest("hex");
    let job = pending.get(hash);
    if (!job) {
      job = render(icon.bytes, hash).finally(() => pending.delete(hash));
      pending.set(hash, job);
    }
    return job;
  };
}

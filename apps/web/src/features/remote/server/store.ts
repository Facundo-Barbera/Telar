import crypto from "node:crypto";
import type { DeviceIdentity } from "./identity";
import fs from "node:fs";
import path from "node:path";
import { canonicalPath, isLegacyTelarHome } from "@/lib/telar-home";

export class RemoteStoreError extends Error {}

export type DeviceRole = "full" | "observer";

type DevicePlatform = "ios" | "browser";

export interface PairedDevice {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt?: number;
  role: DeviceRole;
  platform?: DevicePlatform;
  identity?: DeviceIdentity;
}

interface PendingPairing {
  tokenHash: string;
  attempts?: number;
  createdAt: number;
  expiresAt: number;
}

type ExposureMode = "local-only" | "network-accessible";

export interface RemoteFile {
  version: 1;
  requireAuth: boolean;
  exposure?: ExposureMode;
  tailscaleServe?: boolean;
  devices: PairedDevice[];
  pairing?: PendingPairing;
}

export function remoteHome(
  env: { TELAR_HOME?: string; TELAR_COCKPIT?: string } = process.env as { TELAR_HOME?: string; TELAR_COCKPIT?: string },
): string {
  if (env.TELAR_COCKPIT !== "1") {
    throw new RemoteStoreError("Start the cockpit with bun run dev; ordinary web mode has no pairing store.");
  }
  const telarHome = env.TELAR_HOME?.trim();
  if (!telarHome || !path.isAbsolute(telarHome)) {
    throw new RemoteStoreError("Set an absolute TELAR_HOME before opening the cockpit.");
  }
  const canonicalHome = canonicalPath(telarHome);
  if (isLegacyTelarHome(canonicalHome)) {
    throw new RemoteStoreError("TELAR_HOME must not point at legacy Telar state.");
  }
  return path.join(canonicalHome, "remote");
}

export function storePath(): string {
  return path.join(remoteHome(), "remote.json");
}

const FRESH: RemoteFile = { version: 1, requireAuth: true, devices: [] };

const RESET: RemoteFile = { version: 1, requireAuth: false, devices: [] };

export function readRemote(): RemoteFile {
  const file = storePath();
  if (!fs.existsSync(file)) return { ...FRESH, devices: [] };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as RemoteFile;
  if (parsed.version !== 1) return { ...RESET, devices: [] };
  for (const device of parsed.devices) {
    device.role = device.role === "observer" ? "observer" : "full";
  }
  parsed.exposure = parsed.exposure === "network-accessible" ? "network-accessible" : "local-only";
  return parsed;
}

export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

export function matchDevice(file: RemoteFile, raw: string): PairedDevice | undefined {
  const candidate = Buffer.from(hashToken(raw), "hex");
  let matched: PairedDevice | undefined;
  for (const device of file.devices) {
    const stored = Buffer.from(device.tokenHash, "hex");
    if (stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate)) {
      matched = device;
    }
  }
  return matched;
}

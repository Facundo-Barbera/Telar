import crypto from "node:crypto";
import type { DeviceIdentity } from "./identity";
import fs from "node:fs";
import path from "node:path";
import { canonicalPath, isLegacyTelarHome } from "../telar-home";

export class RemoteStoreError extends Error {}

export type DeviceRole = "full" | "observer";

export type DevicePlatform = "ios" | "browser";

export interface PairedDevice {
  id: string;
  name: string;
  /** sha256 hex of the raw token. Never the token. */
  tokenHash: string;
  createdAt: number;
  lastSeenAt?: number;
  /** Normalized on read: a file written before roles existed reads as "full". */
  role: DeviceRole;
  /** Unknown for devices paired before this field existed. Never inferred. */
  platform?: DevicePlatform;
  /** What it says it is, and what we saw. Absent on devices paired before the
   *  field existed, which read as an unknown kind rather than as a browser. */
  identity?: DeviceIdentity;
}

export interface PendingPairing {
  tokenHash: string;
  /** Wrong guesses so far. Eight digits is 26 bits, which only holds up if
   *  a guesser gets a handful of tries — see `PAIRING_MAX_ATTEMPTS`. */
  attempts?: number;
  createdAt: number;
  expiresAt: number;
}

export type ExposureMode = "local-only" | "network-accessible";

export interface RemoteFile {
  version: 1;
  requireAuth: boolean;
  /** Absent in every file written before this existed, and absent means the
   *  safe answer — a loopback bind is what those installs already had. */
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
  // Anything but the one widening value reads as loopback, so a corrupted or
  // hand-edited field cannot quietly open the socket.
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

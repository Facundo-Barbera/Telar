import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class RemoteStoreError extends Error {}

export type DeviceRole = "full" | "observer";
export type DevicePlatform = "ios" | "browser";
export type ExposureMode = "local-only" | "network-accessible";

export interface DeviceIdentity {
  kind: string;
  client?: string;
  machine?: string;
  os?: string;
  address?: string;
  origin?: string;
}

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

export interface PendingPairing {
  tokenHash: string;
  attempts?: number;
  createdAt: number;
  expiresAt: number;
}

export interface RemoteFile {
  version: 1;
  requireAuth: boolean;
  exposure?: ExposureMode;
  tailscaleServe?: boolean;
  devices: PairedDevice[];
  pairing?: PendingPairing;
}

export type PairingRefusal = "none-pending" | "expired" | "mismatch" | "burned";

const PAIRING_TTL_MS = 5 * 60 * 1000;
export const PAIRING_MAX_ATTEMPTS = 5;
const PAIRING_CODE_DIGITS = 8;
const TOUCH_QUIET_MS = 60_000;
const NAME_MAX = 64;

// A missing file requires pairing; an unreadable version falls open so a damaged file cannot lock the owner out.
const FRESH: RemoteFile = { version: 1, requireAuth: true, devices: [] };
const RESET: RemoteFile = { version: 1, requireAuth: false, devices: [] };

export const remoteDirFor = (engineRoot: string): string => path.join(path.dirname(engineRoot), "remote");

export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

export function mintDeviceToken(): string {
  return "tlr_" + crypto.randomBytes(32).toString("base64url");
}

function mintPairingCode(): string {
  return String(crypto.randomInt(0, 10 ** PAIRING_CODE_DIGITS)).padStart(PAIRING_CODE_DIGITS, "0");
}

export function normalisePairingCode(raw: string): string | undefined {
  const digits = raw.replace(/\D/g, "");
  return digits.length === PAIRING_CODE_DIGITS && raw.replace(/[\s-]/g, "") === digits ? digits : undefined;
}

function sameHash(storedHex: string, raw: string): boolean {
  const stored = Buffer.from(storedHex, "hex");
  const candidate = Buffer.from(hashToken(raw), "hex");
  return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
}

/** Compares against every device with no early return, so timing does not reveal which matched. */
export function matchDevice(file: RemoteFile, raw: string): PairedDevice | undefined {
  let matched: PairedDevice | undefined;
  for (const device of file.devices) {
    if (sameHash(device.tokenHash, raw)) matched = device;
  }
  return matched;
}

const cleanName = (name: string): string => name.trim().slice(0, NAME_MAX) || "Unnamed device";

export function createRemoteStore(dir: string) {
  const file = path.join(dir, "remote.json");

  function read(): RemoteFile {
    if (!fs.existsSync(file)) return { ...FRESH, devices: [] };
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as RemoteFile;
    if (parsed.version !== 1) return { ...RESET, devices: [] };
    for (const device of parsed.devices) device.role = device.role === "observer" ? "observer" : "full";
    parsed.exposure = parsed.exposure === "network-accessible" ? "network-accessible" : "local-only";
    return parsed;
  }

  function write(next: RemoteFile): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function update<T>(change: (current: RemoteFile) => T): T {
    const current = read();
    const result = change(current);
    write(current);
    return result;
  }

  const find = (current: RemoteFile, id: string) => current.devices.find((device) => device.id === id);

  return {
    path: file,
    read,
    write,

    addDevice(name: string, raw: string, options: { platform?: DevicePlatform; role?: DeviceRole; identity?: DeviceIdentity } = {}): PairedDevice {
      const device: PairedDevice = {
        id: "dev_" + crypto.randomBytes(6).toString("hex"),
        name: cleanName(name),
        tokenHash: hashToken(raw),
        createdAt: Date.now(),
        role: options.role ?? "full",
        ...(options.platform ? { platform: options.platform } : {}),
        ...(options.identity ? { identity: options.identity } : {}),
      };
      update((current) => current.devices.push(device));
      return device;
    },

    renameDevice(id: string, name: string): PairedDevice | undefined {
      const current = read();
      const device = find(current, id);
      if (!device) return undefined;
      device.name = cleanName(name);
      write(current);
      return device;
    },

    setDeviceRole(id: string, role: DeviceRole): PairedDevice | undefined {
      const current = read();
      const device = find(current, id);
      if (!device) return undefined;
      const lastFull = current.requireAuth && device.role === "full" && !current.devices.some((other) => other.id !== id && other.role === "full");
      if (role === "observer" && lastFull) throw new RemoteStoreError("Keep at least one device with full access.");
      device.role = role;
      write(current);
      return device;
    },

    revokeDevice(id: string): boolean {
      const current = read();
      const before = current.devices.length;
      current.devices = current.devices.filter((device) => device.id !== id);
      if (current.devices.length === before) return false;
      write(current);
      return true;
    },

    revokeOtherDevices(keepId: string): number {
      const current = read();
      const before = current.devices.length;
      current.devices = current.devices.filter((device) => device.id === keepId);
      const revoked = before - current.devices.length;
      if (revoked > 0) write(current);
      return revoked;
    },

    touchDevice(id: string, nowMs: number = Date.now(), address?: string): void {
      try {
        const current = read();
        const device = find(current, id);
        if (!device) return;
        const moved = address !== undefined && device.identity?.address !== address;
        if (!moved && device.lastSeenAt !== undefined && nowMs - device.lastSeenAt < TOUCH_QUIET_MS) return;
        device.lastSeenAt = nowMs;
        if (moved) device.identity = { kind: device.identity?.kind ?? "unknown", ...device.identity, address };
        write(current);
      } catch {
        return;
      }
    },

    mintPairing(nowMs: number = Date.now(), ttlMs: number = PAIRING_TTL_MS): { code: string; expiresAt: number } {
      const code = mintPairingCode();
      const expiresAt = nowMs + ttlMs;
      update((current) => (current.pairing = { tokenHash: hashToken(code), createdAt: nowMs, expiresAt }));
      return { code, expiresAt };
    },

    clearPairing(): void {
      const current = read();
      if (!current.pairing) return;
      delete current.pairing;
      write(current);
    },

    /** Single-use: a match deletes the pending pairing, and the fifth wrong guess burns it. */
    consumePairing(raw: string, nowMs: number = Date.now()): true | PairingRefusal {
      const current = read();
      const pairing = current.pairing;
      if (!pairing) return "none-pending";
      if (nowMs >= pairing.expiresAt) return "expired";
      const code = normalisePairingCode(raw);
      if (sameHash(pairing.tokenHash, code ?? raw.trim())) {
        delete current.pairing;
        write(current);
        return true;
      }
      pairing.attempts = (pairing.attempts ?? 0) + 1;
      const burned = pairing.attempts >= PAIRING_MAX_ATTEMPTS;
      if (burned) delete current.pairing;
      write(current);
      return burned ? "burned" : "mismatch";
    },

    setExposure(exposure: ExposureMode): RemoteFile {
      return update((current) => {
        if (exposure === "network-accessible" && !current.requireAuth) {
          throw new RemoteStoreError("turn on pairing before opening this cockpit to the network");
        }
        current.exposure = exposure;
        return current;
      });
    },

    setTailscaleServe(enabled: boolean): RemoteFile {
      return update((current) => {
        if (enabled && !current.requireAuth) throw new RemoteStoreError("turn on pairing before publishing this cockpit over Tailscale");
        if (enabled) current.tailscaleServe = true;
        else delete current.tailscaleServe;
        return current;
      });
    },

    setRequireAuth(requireAuth: boolean): RemoteFile {
      return update((current) => {
        current.requireAuth = requireAuth;
        if (!requireAuth) current.exposure = "local-only";
        return current;
      });
    },
  };
}

export type RemoteStore = ReturnType<typeof createRemoteStore>;

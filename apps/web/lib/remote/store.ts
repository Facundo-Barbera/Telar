import crypto from "node:crypto";
import type { DeviceIdentity } from "./identity";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The cockpit's pairing store — WHO may speak to /api from off this machine.
 *
 * COCKPIT-OWNED, NOT ENGINE-OWNED. Device tokens authenticate clients to the
 * cockpit's HTTP surface; the engine's own bearer token (engine.json) is a
 * different credential for a different boundary and rotates per boot. This
 * file lives at <TELAR_HOME>/remote/remote.json — outside engine/, which the
 * engine owns and migrates.
 *
 * ONLY HASHES ARE STORED. A device token (`tlr_…`) is shown once at pairing
 * and never persisted server-side; the file holds sha256 digests, compared in
 * constant time. Losing the file logs every device out and nothing else —
 * which is also the documented recovery from a lockout:
 *
 *     rm <TELAR_HOME>/remote/remote.json
 *
 * NO NEXT AND NO ENGINE-CLIENT IMPORTS. The proxy gate loads this module on
 * every request; it must stay a leaf.
 */

export class RemoteStoreError extends Error {}

/**
 * The whole capability model: full may do anything, observer may only read
 * (GET/HEAD — enforced in gate.ts). Deliberately an enum, not a capability
 * set: since an observer cannot PATCH the device routes, it cannot escalate
 * itself, and no per-route rules are needed.
 */
export type DeviceRole = "full" | "observer";

/**
 * RETIRED, AND KEPT ONLY FOR FILES THAT ALREADY HOLD IT. A two-value enum of
 * `ios` and `browser` said the only things that pair with a cockpit are a
 * phone app and a web page, which was never true and is why every row read
 * "Browser". `DeviceIdentity` replaced it — see lib/remote/identity.ts.
 */
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
  /**
   * THE CODE'S HASH — eight digits, the one pairing secret. It is what a
   * person types, what the QR encodes and what the link carries; there is
   * no second, longer token any more. Named `tokenHash` still because the
   * field pre-dates short codes and a pending pairing written by the old
   * build (a long `tlr_…` token) must keep answering to it.
   */
  tokenHash: string;
  /** Wrong guesses so far. Eight digits is 26 bits, which only holds up if
   *  a guesser gets a handful of tries — see `PAIRING_MAX_ATTEMPTS`. */
  attempts?: number;
  createdAt: number;
  expiresAt: number;
}

/**
 * WHERE THE COCKPIT'S SOCKET LISTENS.
 *
 * `local-only` binds 127.0.0.1 and is reachable from this machine and nothing
 * else. `network-accessible` binds every interface, which is what makes a
 * pairing URL on the tailnet resolve to an actual socket.
 *
 * IT LIVES HERE BECAUSE IT IS A REMOTE-ACCESS FACT, beside `requireAuth` and
 * the paired devices — the three things that together decide who can reach
 * this cockpit. The desktop shell reads this same file at launch to choose its
 * bind address, which is why the value is a plain string rather than anything
 * needing the web app to interpret it.
 */
export type ExposureMode = "local-only" | "network-accessible";

export interface RemoteFile {
  version: 1;
  requireAuth: boolean;
  /** Absent in every file written before this existed, and absent means the
   *  safe answer — a loopback bind is what those installs already had. */
  exposure?: ExposureMode;
  /**
   * PUBLISH OVER TAILSCALE SERVE — a ts.net HTTPS name with a real
   * certificate, which is what lets a phone browser reach the cockpit
   * without an IP and with a secure context. Read by the launchers at
   * start-up, like `exposure`: the web process never spawns `tailscale`
   * itself (Mac App Store Tailscale re-prompts consent per spawn), so a
   * change here asks for a restart rather than pretending it took.
   */
  tailscaleServe?: boolean;
  devices: PairedDevice[];
  pairing?: PendingPairing;
}

/**
 * FIVE MINUTES, DOWN FROM TEN, because the code got short. A 256-bit token
 * could sit in a QR all day; an eight-digit code is what a person types off
 * a screen, and the window it lives in is part of what keeps 10⁸ guesses
 * out of reach — the other part is `PAIRING_MAX_ATTEMPTS`.
 */
export const PAIRING_TTL_MS = 5 * 60 * 1000;

/** Wrong guesses before the pending code is burned. Five is what a person
 *  mistyping needs; a guesser needs millions. */
export const PAIRING_MAX_ATTEMPTS = 5;

export const PAIRING_CODE_DIGITS = 8;

/**
 * The same home discipline as engineRootFromWebEnv (lib/engine/engine-server.ts),
 * duplicated rather than imported so this module stays engine-free: launcher
 * flag required, absolute home, symlinks canonicalized, legacy homes refused.
 */
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

function canonicalPath(input: string): string {
  const resolved = path.resolve(input);
  let existing = resolved;
  const missing: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  let canonical = fs.realpathSync.native(existing);
  for (const segment of missing) canonical = path.join(canonical, segment);
  return canonical;
}

function isLegacyTelarHome(canonicalHome: string): boolean {
  const userHome = canonicalPath(os.homedir());
  return path.dirname(canonicalHome) === userHome && [".telar", ".telar-dev"].includes(path.basename(canonicalHome));
}

export function storePath(): string {
  return path.join(remoteHome(), "remote.json");
}

const EMPTY: RemoteFile = { version: 1, requireAuth: false, devices: [] };

export function readRemote(): RemoteFile {
  const file = storePath();
  if (!fs.existsSync(file)) return { ...EMPTY, devices: [] };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as RemoteFile;
  if (parsed.version !== 1) return { ...EMPTY, devices: [] };
  for (const device of parsed.devices) {
    device.role = device.role === "observer" ? "observer" : "full";
  }
  // Anything but the one widening value reads as loopback, so a corrupted or
  // hand-edited field cannot quietly open the socket.
  parsed.exposure = parsed.exposure === "network-accessible" ? "network-accessible" : "local-only";
  return parsed;
}

export function writeRemote(file: RemoteFile): void {
  const target = storePath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

export function mintDeviceToken(): string {
  return "tlr_" + crypto.randomBytes(32).toString("base64url");
}

/**
 * Constant-time device lookup: the candidate is hashed ONCE, then every
 * stored digest is compared with timingSafeEqual, with no early return — the
 * loop's duration does not depend on which (if any) device matched.
 */
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

const NAME_MAX = 64;

function cleanName(name: string): string {
  return name.trim().slice(0, NAME_MAX) || "Unnamed device";
}

/** Registers a device for a freshly minted raw token; returns the device. */
export function addDevice(
  name: string,
  raw: string,
  options?: { platform?: DevicePlatform; role?: DeviceRole; identity?: DeviceIdentity },
): PairedDevice {
  const file = readRemote();
  const device: PairedDevice = {
    id: "dev_" + crypto.randomBytes(6).toString("hex"),
    name: cleanName(name),
    tokenHash: hashToken(raw),
    createdAt: Date.now(),
    role: options?.role ?? "full",
    ...(options?.platform ? { platform: options.platform } : {}),
    ...(options?.identity ? { identity: options.identity } : {}),
  };
  file.devices.push(device);
  writeRemote(file);
  return device;
}

export function renameDevice(id: string, name: string): PairedDevice | undefined {
  const file = readRemote();
  const device = file.devices.find((candidate) => candidate.id === id);
  if (!device) return undefined;
  device.name = cleanName(name);
  writeRemote(file);
  return device;
}

/**
 * Demoting the LAST full device while the gate is on is refused: a silent
 * demotion still answers every GET, so it looks like control you no longer
 * have. Revoking the last device stays permitted — that failure is loud, and
 * `rm remote/remote.json` is the documented recovery either way.
 */
export function setDeviceRole(id: string, role: DeviceRole): PairedDevice | undefined {
  const file = readRemote();
  const device = file.devices.find((candidate) => candidate.id === id);
  if (!device) return undefined;
  if (
    role === "observer" &&
    file.requireAuth &&
    device.role === "full" &&
    !file.devices.some((other) => other.id !== id && other.role === "full")
  ) {
    throw new RemoteStoreError("Keep at least one device with full access.");
  }
  device.role = role;
  writeRemote(file);
  return device;
}

export function revokeDevice(id: string): boolean {
  const file = readRemote();
  const before = file.devices.length;
  file.devices = file.devices.filter((device) => device.id !== id);
  if (file.devices.length === before) return false;
  writeRemote(file);
  return true;
}

/** The lost-phone button. Returns how many were revoked. */
export function revokeOtherDevices(keepId: string): number {
  const file = readRemote();
  const before = file.devices.length;
  file.devices = file.devices.filter((device) => device.id === keepId);
  const revoked = before - file.devices.length;
  if (revoked > 0) writeRemote(file);
  return revoked;
}

/**
 * Stamp lastSeenAt, throttled: /api is polled every second, and an
 * unconditional stamp would rewrite the file per poll. Never throws — a
 * failed stamp must not fail the request it decorates.
 */
export function touchDevice(id: string, nowMs: number = Date.now(), address?: string): void {
  try {
    const file = readRemote();
    const device = file.devices.find((candidate) => candidate.id === id);
    if (!device) return;
    // A MOVED DEVICE IS WORTH A WRITE even inside the quiet minute: "last seen
    // from" is only useful if it tracks, and a laptop changing networks is
    // exactly the moment a reader wants the row to update.
    const moved = address !== undefined && device.identity?.address !== address;
    if (!moved && device.lastSeenAt !== undefined && nowMs - device.lastSeenAt < 60_000) return;
    device.lastSeenAt = nowMs;
    if (moved) device.identity = { kind: device.identity?.kind ?? "unknown", ...device.identity, address };
    writeRemote(file);
  } catch {
    // Advisory metadata only.
  }
}

/**
 * An eight-digit code from the CSPRNG, uniform over 10⁸ — `randomInt` rather
 * than `random() * 1e8`, and zero-padded so "00123456" is as likely as any.
 */
export function mintPairingCode(): string {
  return String(crypto.randomInt(0, 10 ** PAIRING_CODE_DIGITS)).padStart(PAIRING_CODE_DIGITS, "0");
}

/** What a person typed, normalised: digits only, so "4812 9037" and
 *  "4812-9037" are the same code. Anything else is not a code. */
export function normalisePairingCode(raw: string): string | undefined {
  const digits = raw.replace(/\D/g, "");
  return digits.length === PAIRING_CODE_DIGITS && raw.replace(/[\s-]/g, "") === digits ? digits : undefined;
}

/**
 * Mints a pairing, replacing any pending one. Returns the RAW code — the
 * only moment it exists outside a QR, a clipboard or a screen. ONE SECRET:
 * the same eight digits are typed, scanned and linked. A first cut kept a
 * long token beside the code "for the QR"; that showed the person two
 * different secrets for one act and taught them the short one was the
 * lesser. The QR is a convenience for entering the code, not a second key.
 */
export function mintPairing(nowMs: number = Date.now(), ttlMs: number = PAIRING_TTL_MS): { code: string; expiresAt: number } {
  const file = readRemote();
  const code = mintPairingCode();
  const expiresAt = nowMs + ttlMs;
  file.pairing = { tokenHash: hashToken(code), createdAt: nowMs, expiresAt };
  writeRemote(file);
  return { code, expiresAt };
}

export function clearPairing(): void {
  const file = readRemote();
  if (!file.pairing) return;
  delete file.pairing;
  writeRemote(file);
}

/**
 * One-time by construction: a successful consume deletes the pending pairing
 * before returning, so a replayed token meets an empty slot.
 */
export type PairingRefusal = "none-pending" | "expired" | "mismatch" | "burned";

/**
 * WHY IT FAILED, NOT JUST THAT IT DID.
 *
 * This returned a bare boolean and the route rendered every false as "expired
 * or already used" — so a code that was never minted here, a code from another
 * instance, and a genuinely stale one all produced the same sentence, and the
 * one question worth answering ("is my clock wrong, or am I pairing against
 * the wrong cockpit?") had no evidence behind it.
 *
 * The three causes are genuinely different things to do about it:
 *   none-pending  nothing was minted here, or it was already used
 *   expired       minted here, ten minutes passed
 *   mismatch      a real code, but not this cockpit's — the usual cause is
 *                 two instances open and the code coming from the other one
 *   burned        too many wrong guesses; the pending code was destroyed
 *
 * Still one-time by construction: a successful consume deletes the pending
 * pairing before returning, so a replayed token meets an empty slot.
 *
 * WRONG GUESSES ARE COUNTED AND THE FIFTH BURNS THE CODE. Eight digits is
 * 26 bits — without a cap, 10⁸ guesses inside the TTL is a laptop's
 * afternoon on a LAN. A pending pairing written by the old build holds a
 * long token; it is tried verbatim, so that install's open QR still works
 * once after the upgrade.
 */
export function consumePairing(raw: string, nowMs: number = Date.now()): true | PairingRefusal {
  const file = readRemote();
  const pairing = file.pairing;
  if (!pairing) return "none-pending";
  if (nowMs >= pairing.expiresAt) return "expired";
  const same = (value: string) => {
    const stored = Buffer.from(pairing.tokenHash, "hex");
    const candidate = Buffer.from(hashToken(value), "hex");
    return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
  };
  const code = normalisePairingCode(raw);
  const matched = code !== undefined ? same(code) : same(raw.trim());
  if (!matched) {
    pairing.attempts = (pairing.attempts ?? 0) + 1;
    if (pairing.attempts >= PAIRING_MAX_ATTEMPTS) {
      delete file.pairing;
      writeRemote(file);
      return "burned";
    }
    writeRemote(file);
    return "mismatch";
  }
  delete file.pairing;
  writeRemote(file);
  return true;
}

/**
 * WIDENING REQUIRES THE GATE TO BE ON. Binding every interface with
 * `requireAuth` off would put an unauthenticated cockpit on whatever network
 * this machine is attached to — a coffee-shop wifi, not just a tailnet. The
 * refusal is here rather than in the UI so it holds for every caller.
 */
export function setExposure(exposure: ExposureMode): RemoteFile {
  const file = readRemote();
  if (exposure === "network-accessible" && !file.requireAuth) {
    throw new Error("turn on pairing before opening this cockpit to the network");
  }
  file.exposure = exposure;
  writeRemote(file);
  return file;
}

/** Same gate as `setExposure`, for the same reason: a ts.net name is a door
 *  onto the tailnet, and it must not open with nothing behind it. */
export function setTailscaleServe(enabled: boolean): RemoteFile {
  const file = readRemote();
  if (enabled && !file.requireAuth) {
    throw new Error("turn on pairing before publishing this cockpit over Tailscale");
  }
  if (enabled) file.tailscaleServe = true;
  else delete file.tailscaleServe;
  writeRemote(file);
  return file;
}

export function setRequireAuth(requireAuth: boolean): RemoteFile {
  const file = readRemote();
  file.requireAuth = requireAuth;
  // AND TURNING THE GATE OFF CLOSES THE SOCKET. Otherwise the one action a
  // person takes to make this cockpit *less* guarded would leave it bound to
  // every interface with nothing in front of it.
  if (!requireAuth) file.exposure = "local-only";
  writeRemote(file);
  return file;
}

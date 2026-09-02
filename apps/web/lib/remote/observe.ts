import { execFileSync } from "node:child_process";
import os from "node:os";
import { cleanDeclared, cleanKind, sniffUserAgent, type DeviceIdentity } from "./identity";

/**
 * WHAT THE SERVER CAN SEE FOR ITSELF, merged with what the caller claimed.
 *
 * Both ways a device enters the list — the pairing exchange and the
 * anti-lockout self-pair that runs when the gate is switched on — need the
 * same answer, and the second one used to skip the question entirely and write
 * the literal string "This browser". That row could not be told from any other
 * browser, which is the failure this module exists to stop repeating.
 */

/** The peer address, from whichever header this deployment actually sets. Next
 *  does not expose the socket and the cockpit sits behind its own proxy, so the
 *  forwarded chain is the only source — FIRST HOP, because everything after it
 *  is whatever the client felt like appending. */
export function peerAddress(request: Request): string | undefined {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidate = forwarded || request.headers.get("x-real-ip")?.trim();
  return candidate && candidate.length <= 64 ? candidate : undefined;
}

/** Which origin it paired against — pairing is per-origin, so this is how a
 *  reader tells a loopback pairing from a tailnet one for the same machine. */
export function originOf(request: Request): string | undefined {
  try {
    return new URL(request.url).host.slice(0, 64) || undefined;
  } catch {
    return undefined;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * IS THE CALLER ON THIS MACHINE? Answered from the host it dialled, not from
 * the address it came from — a loopback address in a header is a claim, but a
 * request that ARRIVED on 127.0.0.1 cannot have crossed a network to get here.
 * That is what makes it safe to attach this server's hostname to the row.
 */
export function dialledLoopback(request: Request): boolean {
  const host = originOf(request);
  if (!host) return false;
  const bare = host.replace(/:\d+$/, "");
  return LOOPBACK.has(bare);
}

/**
 * THIS MACHINE'S NAME, AS ITS OWNER KNOWS IT.
 *
 * `os.hostname()` is the DNS name, and on macOS that is a different string
 * from the one in System Settings — this box answers "mac.lan" to Node and
 * "MINI-FBARBERA" to every native client that pairs with it. Two rows for the
 * same machine under two names is exactly the confusion this list exists to
 * remove, so the user-facing name wins where one can be had.
 *
 * ONE SPAWN PER PROCESS, cached, and never on the request path after the
 * first. `scutil` is not TCC-guarded (unlike `tailscale`, which is why
 * endpoints.ts spawns nothing at all), and any failure falls through to the
 * hostname rather than mattering.
 */
let computerName: string | null | undefined;

function macComputerName(): string | undefined {
  if (computerName !== undefined) return computerName ?? undefined;
  computerName = null;
  if (process.platform === "darwin") {
    try {
      computerName = execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 1500 }).trim() || null;
    } catch {
      computerName = null;
    }
  }
  return computerName ?? undefined;
}

/** Short form — "mini-fbarbera.local" is the same box as "mini-fbarbera" and
 *  the suffix only costs row width. */
export function machineName(hostname: string = macComputerName() ?? os.hostname()): string | undefined {
  return cleanDeclared(hostname.replace(/\.local$/i, ""), 48);
}

export interface DeclaredIdentity {
  kind?: unknown;
  client?: unknown;
  machine?: unknown;
  os?: unknown;
}

/**
 * Declared beats sniffed, sniffed beats nothing, and the observed fields are
 * appended regardless — a caller cannot claim to have connected from somewhere
 * it did not, which is what makes those the ones worth trusting when two rows
 * look alike.
 */
export function observeIdentity(request: Request, declared: DeclaredIdentity = {}): DeviceIdentity {
  const sniffed = sniffUserAgent(request.headers.get("user-agent"));
  const client = cleanDeclared(declared.client) ?? sniffed.client;
  const platformOs = cleanDeclared(declared.os) ?? sniffed.os;
  // Only when it dialled loopback: on any other origin the hostname would be
  // this server's machine attributed to somebody else's device.
  const machine = cleanDeclared(declared.machine) ?? (dialledLoopback(request) ? machineName() : undefined);
  const address = peerAddress(request);
  const origin = originOf(request);
  return {
    kind: cleanKind(declared.kind) ?? sniffed.kind,
    ...(client ? { client } : {}),
    ...(machine ? { machine } : {}),
    ...(platformOs ? { os: platformOs } : {}),
    ...(address ? { address } : {}),
    ...(origin ? { origin } : {}),
  };
}

import { execFileSync } from "node:child_process";
import os from "node:os";
import type { DeviceIdentity } from "@telar/engine-client";
import { cleanDeclared, cleanKind, sniffUserAgent } from "./identity";

export function peerAddress(request: Request): string | undefined {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidate = forwarded || request.headers.get("x-real-ip")?.trim();
  return candidate && candidate.length <= 64 ? candidate : undefined;
}

function originOf(request: Request): string | undefined {
  try {
    return new URL(request.url).host.slice(0, 64) || undefined;
  } catch {
    return undefined;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function dialledLoopback(request: Request): boolean {
  const host = originOf(request);
  if (!host) return false;
  const bare = host.replace(/:\d+$/, "");
  return LOOPBACK.has(bare);
}

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

export function machineName(hostname: string = macComputerName() ?? os.hostname()): string | undefined {
  return cleanDeclared(hostname.replace(/\.local$/i, ""), 48);
}

export interface DeclaredIdentity {
  kind?: unknown;
  client?: unknown;
  machine?: unknown;
  os?: unknown;
}

export function observeIdentity(request: Request, declared: DeclaredIdentity = {}): DeviceIdentity {
  const sniffed = sniffUserAgent(request.headers.get("user-agent"));
  const client = cleanDeclared(declared.client) ?? sniffed.client;
  const platformOs = cleanDeclared(declared.os) ?? sniffed.os;
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

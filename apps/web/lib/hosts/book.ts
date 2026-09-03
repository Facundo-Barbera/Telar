/**
 * OTHER MACS — the rules, pure.
 *
 * The desktop cockpit talks to one engine: its own, on this machine. A person
 * who also runs Telar on a Mac mini has to reach it from a browser tab, and
 * its conversations never sit beside the local ones. The iOS app already
 * solved this (`apps/ios/TelarMobile/Stores/Host.swift`); this is that model,
 * ported: a host is a paired cockpit at an address, with a local identity
 * minted when it is added — because the engine's `daemonId` is behind the
 * pairing gate and is minted fresh every daemon start, so it can dedupe but
 * never identify.
 *
 * PURE ON PURPOSE, like `HostBook` is: no filesystem, no fetch, so every
 * dedupe/merge/rename rule is a unit test. The store (./store.ts) reads and
 * writes; the routes call.
 */

/** The address the LOCAL engine answers under in every route that takes a
 *  host — it is the absence of a proxy hop, not a row in the book. */
export const LOCAL_HOST_ID = "local";

export interface Host {
  id: string;
  /** Label; defaults to the engine's own hostname or the URL's host. */
  name: string;
  /** Origin of the REMOTE COCKPIT (its Next server), e.g. `http://mini.tail:3000`.
   *  Never a path: every request appends `/api/…` to it. */
  baseUrl: string;
  /** The device token that cockpit minted for this desktop at pairing. */
  deviceToken: string;
  /** Learned from `/api/health` when reachable; only ever used to dedupe
   *  "same Mac, new address". */
  daemonId?: string;
  addedAt: number;
}

export interface HostsFile {
  version: 1;
  hosts: Host[];
}

/**
 * Same Mac, spelled differently: lowercased scheme+host, explicit default
 * port, no trailing slash, no path. Two rows for `http://mini:3000/` and
 * `HTTP://MINI:3000` would be one Mac paired twice.
 */
export function normalizeBaseUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (!url.hostname) return undefined;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${url.protocol}//${url.hostname.toLowerCase()}:${port}`;
}

/** The label when the human has not named it: host, plus the port when it is
 *  not the scheme default — two cockpits on one machine must not both read
 *  "mini". */
export function defaultHostName(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const defaultPort = url.protocol === "https:" ? "443" : "80";
    return url.port && url.port !== defaultPort ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return baseUrl;
  }
}

/**
 * The pairing URL the other cockpit shows in Settings → Remote access:
 * `http://host:port/pair#token=tlr_…`. The token rides in the FRAGMENT so it
 * never reaches a server log; a token in the query is refused for that
 * reason (the same rule iOS's `parsePairingURL` applies).
 */
export function parsePairingUrl(text: string): { baseUrl: string; token: string } | undefined {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.searchParams.has("token")) return undefined;
  const params = new URLSearchParams(url.hash.replace(/^#/, ""));
  const token = params.get("token");
  if (!token || !/^tlr_[A-Za-z0-9_-]+$/.test(token)) return undefined;
  const base = normalizeBaseUrl(url.origin);
  if (!base) return undefined;
  return { baseUrl: base, token };
}

export type Upsert = { kind: "added"; host: Host } | { kind: "replaced"; host: Host };

/**
 * Pairing ADDS: dedupe by normalized URL — a re-pair of a known address keeps
 * the host's id (and everything keyed on it) and takes the new token; it
 * never duplicates and never evicts another host.
 */
export function upsertHost(
  hosts: readonly Host[],
  input: { baseUrl: string; deviceToken: string; name?: string; daemonId?: string },
  now: number,
  mintId: () => string,
): { hosts: Host[]; result: Upsert } {
  const normalized = normalizeBaseUrl(input.baseUrl) ?? input.baseUrl;
  const index = hosts.findIndex((host) => normalizeBaseUrl(host.baseUrl) === normalized);
  if (index >= 0) {
    const existing = hosts[index]!;
    const host: Host = {
      ...existing,
      baseUrl: normalized,
      deviceToken: input.deviceToken,
      ...(input.daemonId ? { daemonId: input.daemonId } : {}),
      ...(input.name ? { name: input.name } : {}),
    };
    const next = hosts.slice();
    next[index] = host;
    return { hosts: next, result: { kind: "replaced", host } };
  }
  const host: Host = {
    id: mintId(),
    name: input.name?.trim() || defaultHostName(normalized),
    baseUrl: normalized,
    deviceToken: input.deviceToken,
    ...(input.daemonId ? { daemonId: input.daemonId } : {}),
    addedAt: now,
  };
  return { hosts: [...hosts, host], result: { kind: "added", host } };
}

/**
 * Learned identity: if another record already carries this daemonId, the
 * same Mac was added under two addresses — merge into the OLDER record (its
 * id owns everything keyed on it) and keep the newer address and token.
 */
export function recordDaemonId(hosts: readonly Host[], id: string, daemonId: string): { hosts: Host[]; merged: boolean } {
  const index = hosts.findIndex((host) => host.id === id);
  if (index < 0) return { hosts: hosts.slice(), merged: false };
  const twin = hosts.findIndex((host) => host.id !== id && host.daemonId === daemonId);
  if (twin < 0) {
    const next = hosts.slice();
    next[index] = { ...hosts[index]!, daemonId };
    return { hosts: next, merged: false };
  }
  const older = hosts[twin]!.addedAt <= hosts[index]!.addedAt ? twin : index;
  const newer = older === twin ? index : twin;
  const kept: Host = { ...hosts[older]!, baseUrl: hosts[newer]!.baseUrl, deviceToken: hosts[newer]!.deviceToken, daemonId };
  const next = hosts.filter((_, i) => i !== newer).map((host) => (host.id === kept.id ? kept : host));
  return { hosts: next, merged: true };
}

export function renameHost(hosts: readonly Host[], id: string, name: string): Host[] {
  const trimmed = name.trim();
  return hosts.map((host) => (host.id === id ? { ...host, name: trimmed || defaultHostName(host.baseUrl) } : host));
}

export function removeHost(hosts: readonly Host[], id: string): Host[] {
  return hosts.filter((host) => host.id !== id);
}

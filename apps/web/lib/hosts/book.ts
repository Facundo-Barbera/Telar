/**
 * Pure rules for other paired Macs, ported from iOS's `Host.swift`. A host gets a
 * local id at pairing: the engine's `daemonId` is minted fresh every daemon
 * start, so it can dedupe but never identify.
 */

/** The local engine: no proxy hop, not a row in the book. */
export const LOCAL_HOST_ID = "local";

export interface Host {
  id: string;
  /** Label; defaults to the engine's own hostname or the URL's host. */
  name: string;
  /** Origin of the remote cockpit, e.g. `http://mini.tail:3000`; never a path. */
  baseUrl: string;
  deviceToken: string;
  /** Only used to dedupe "same Mac, new address". */
  daemonId?: string;
  addedAt: number;
}

export interface HostsFile {
  version: 1;
  hosts: Host[];
}

/** Lowercased scheme+host, explicit port, no trailing slash or path. */
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

/** Includes a non-default port, so two cockpits on one machine get distinct names. */
export function defaultHostName(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const defaultPort = url.protocol === "https:" ? "443" : "80";
    return url.port && url.port !== defaultPort ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return baseUrl;
  }
}

/** Eight-digit code or an older `tlr_` token; mirrors iOS's `looksLikePairingSecret`. */
export function looksLikePairingSecret(token: string): boolean {
  return /^tlr_[A-Za-z0-9_-]+$/.test(token) || /^\d{8}$/.test(token);
}

/**
 * Parses `http://host:port/pair#token=…`. The token must be in the fragment so it
 * never reaches a server log; a query token is refused, as on iOS.
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
  if (!token || !looksLikePairingSecret(token)) return undefined;
  const base = normalizeBaseUrl(url.origin);
  if (!base) return undefined;
  return { baseUrl: base, token };
}

export type Upsert = { kind: "added"; host: Host } | { kind: "replaced"; host: Host };

/** Dedupes by normalised URL: a re-pair keeps the id and takes the new token. */
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

/** Two records with one daemonId merge into the older (its id owns keyed data), keeping the newer address and token. */
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

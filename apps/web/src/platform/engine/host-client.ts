
import { LOCAL_HOST_ID } from "@telar/engine-client";

export { LOCAL_HOST_ID };

export function hostFromPathname(pathname: string): string {
  const match = /^\/hosts\/([^/?#]+)/.exec(pathname);
  if (!match) return LOCAL_HOST_ID;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1]!;
  }
}

export function hostPrefix(hostId: string | undefined): string {
  return !hostId || hostId === LOCAL_HOST_ID ? "" : `/hosts/${encodeURIComponent(hostId)}`;
}

export function rewriteApiPath(pathname: string, hostId: string): string {
  if (hostId === LOCAL_HOST_ID || !pathname.startsWith("/api/")) return pathname;
  if (pathname.startsWith("/api/hosts/") || pathname === "/api/hosts") return pathname;
  return `/api/hosts/${encodeURIComponent(hostId)}${pathname.slice("/api".length)}`;
}

type Fetcher = typeof fetch;

export const HOST_NAME_HEADER = "telar-host";

const observedNames = new Map<string, string>();

export function hostName(hostId: string | undefined): string | undefined {
  if (!hostId || hostId === LOCAL_HOST_ID) return undefined;
  return observedNames.get(hostId);
}

export function rememberHostName(hostId: string, name: string): void {
  const trimmed = name.trim();
  if (hostId === LOCAL_HOST_ID || !trimmed) return;
  observedNames.set(hostId, trimmed);
}

export type PinnedFetcher = Fetcher & { readonly telarHostId: string };

export function pinnedHost(fetcher: Fetcher): string | undefined {
  return (fetcher as Partial<PinnedFetcher>).telarHostId;
}

export function hostFetcher(hostId: string, given?: Fetcher): PinnedFetcher {
  const base: Fetcher = given ?? ((input, init) => fetch(input, init));
  if (hostId === LOCAL_HOST_ID) {
    const local: Fetcher = (input, init) => base(input, init);
    return Object.assign(local, { telarHostId: LOCAL_HOST_ID });
  }
  const remote: Fetcher = async (input, init) => {
    const response = typeof input === "string" ? await base(rewriteApiPath(input, hostId), init) : await base(input, init);
    const name = response.headers.get(HOST_NAME_HEADER);
    if (name) rememberHostName(hostId, name);
    return response;
  };
  return Object.assign(remote, { telarHostId: hostId });
}

export const pathnameFetcher: Fetcher = (input, init) => {
  if (typeof window === "undefined" || typeof input !== "string") return fetch(input, init);
  return fetch(rewriteApiPath(input, hostFromPathname(window.location.pathname)), init);
};

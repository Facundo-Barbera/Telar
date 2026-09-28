import { createEngineApi } from "@/platform/engine/index";
import { sessionConnection } from "@/platform/engine/index";
import { INITIAL_TURNS } from "@/platform/engine/index";
import { hostFetcher, LOCAL_HOST_ID } from "@/lib/hosts/client";
import { LOCAL_HOST } from "../snapshot-cache";

export const PREFETCH_CAP = 3;

export const PREFETCH_INTENT_MS = 150;

export const PREFETCH_MARGIN = "160px";

const warmed = new Map<string, { active: boolean }>();

export function claimPrefetch(key: string, options: { active?: boolean; intent?: boolean } = {}): boolean {
  const active = options.active ?? false;
  const held = warmed.get(key);
  if (held) {
    warmed.delete(key);
    warmed.set(key, { active: held.active || active });
    return true;
  }
  if (warmed.size >= PREFETCH_CAP) {
    if (!active && !options.intent) return false;
    const evictable = [...warmed].find(([, entry]) => !entry.active);
    if (!evictable && !active) return false;
    if (evictable) warmed.delete(evictable[0]);
  }
  warmed.set(key, { active });
  return true;
}

export function releasePrefetch(key: string): void {
  warmed.delete(key);
}

export function warmedRows(): string[] {
  return [...warmed.keys()];
}

export function resetPrefetch(): void {
  warmed.clear();
}

export function warmConversation(hostId: string | undefined, sessionId: string): void {
  void sessionConnection(hostId ?? LOCAL_HOST, createEngineApi(hostFetcher(hostId ?? LOCAL_HOST_ID)), sessionId, { turns: INITIAL_TURNS })
    .read()
    .catch(() => undefined);
}

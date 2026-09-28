"use client";

/**
 * The inbox's settling rule, stored on the engine so every client bands alike. Not polled:
 * changes made here are announced by a window event. One shared read per host; a saved
 * value outranks any read that was already in flight (see `generation`).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { DEFAULT_INBOX_POLICY, type InboxPolicy } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { hostFetcher, hostFromPathname, LOCAL_HOST_ID } from "@/lib/hosts/client";

/** Bounds staleness for changes made elsewhere; changes made here arrive by event. */
export const INBOX_POLICY_TTL_MS = 30_000;

type Shared = {
  policy?: InboxPolicy;
  at?: number;
  inFlight?: Promise<InboxPolicy>;
  /** Bumped by every authoritative write; a read from an older generation does not commit. */
  generation: number;
};
const byHost = new Map<string, Shared>();
const sharedFor = (hostId: string): Shared => {
  const existing = byHost.get(hostId);
  if (existing) return existing;
  const created: Shared = { generation: 0 };
  byHost.set(hostId, created);
  return created;
};

/** Pinned to the given host, not the address bar, so a read is never cached under the wrong host. */
const apiFor = (hostId: string) => createEngineApi(hostFetcher(hostId || LOCAL_HOST_ID));

/** One read shared by every caller. `fetchPolicy` is injectable for tests. */
export function readInboxPolicy(
  hostId: string,
  fetchPolicy: () => Promise<InboxPolicy> = () => apiFor(hostId).inbox().then((result) => result.inbox),
  now: () => number = Date.now,
): Promise<InboxPolicy> {
  const shared = sharedFor(hostId);
  if (shared.policy !== undefined && shared.at !== undefined && now() - shared.at < INBOX_POLICY_TTL_MS) {
    return Promise.resolve(shared.policy);
  }
  if (shared.inFlight) return shared.inFlight;
  const startedAt = shared.generation;
  const flight = fetchPolicy()
    .then((policy) => {
      // Superseded by a save while in flight: keep the authoritative value.
      if (shared.generation !== startedAt) return shared.policy ?? policy;
      shared.policy = policy;
      shared.at = now();
      return policy;
    })
    .finally(() => {
      shared.inFlight = undefined;
    });
  shared.inFlight = flight;
  return flight;
}

/** What the engine just accepted, which outranks any read still in flight. */
export function rememberInboxPolicy(hostId: string, policy: InboxPolicy, now: () => number = Date.now): void {
  const shared = sharedFor(hostId);
  shared.policy = policy;
  shared.at = now();
  shared.generation += 1;
}

/** Test seam: forget every host's answer. */
export function forgetInboxPolicies(): void {
  byHost.clear();
}

/** Same-window propagation, tagged with its host so listeners on another Mac ignore it. */
const CHANGED = "telar:inbox-policy";
type Announcement = { hostId: string; policy: InboxPolicy };

function announce(hostId: string, policy: InboxPolicy): void {
  window.dispatchEvent(new CustomEvent<Announcement>(CHANGED, { detail: { hostId, policy } }));
}

export type InboxPolicyHandle = {
  policy: InboxPolicy;
  /** True until the engine has answered once; the default policy is used meanwhile. */
  loading: boolean;
  save: (patch: { autoSettleAfterHours?: number | null; settleDelegatedAfterHours?: number | null; settledTerminalLimit?: number }) => Promise<void>;
  /** The engine refused: a window outside 1..90, or an unreachable daemon. */
  error?: string;
};

/** Uses the default policy until the engine answers, so settled rows never flash into the live list. */
export function useInboxPolicy(): InboxPolicyHandle {
  const [policy, setPolicy] = useState<InboxPolicy>(DEFAULT_INBOX_POLICY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  /** The host comes from the address bar and is a dependency, so moving between Macs re-reads. */
  const pathname = usePathname();
  const hostId = hostFromPathname(pathname ?? "/");
  /** For callbacks, so an answer that lands after a navigation can be dropped. */
  const host = useRef(hostId);
  useEffect(() => {
    host.current = hostId;
  }, [hostId]);

  // A different Mac is a different rule: reset during render so no frame uses the old one.
  const [subject, setSubject] = useState(hostId);
  if (subject !== hostId) {
    setSubject(hostId);
    setPolicy(DEFAULT_INBOX_POLICY);
    setLoading(true);
  }

  useEffect(() => {
    const asked = hostId;
    // Deferred a tick: setting state from the effect body is what the lint rule forbids.
    const task = window.setTimeout(() => {
      void readInboxPolicy(asked)
        .then((next) => {
          if (host.current === asked) setPolicy(next);
        })
        .catch(() => undefined)
        .finally(() => {
          if (host.current === asked) setLoading(false);
        });
    }, 0);
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<Announcement>).detail;
      if (detail?.policy && detail.hostId === asked && host.current === asked) setPolicy(detail.policy);
    };
    window.addEventListener(CHANGED, onChanged);
    return () => {
      window.clearTimeout(task);
      window.removeEventListener(CHANGED, onChanged);
    };
  }, [hostId]);

  const save = useCallback(async (patch: { autoSettleAfterHours?: number | null; settleDelegatedAfterHours?: number | null; settledTerminalLimit?: number }) => {
    // Fixed before the request, so a late answer is attributed to the Mac it was sent to.
    const asked = hostId;
    try {
      const result = await apiFor(asked).setInbox(patch);
      rememberInboxPolicy(asked, result.inbox);
      if (host.current === asked) {
        setPolicy(result.inbox);
        setError(undefined);
      }
      // Announce what the engine returned, never what was sent.
      announce(asked, result.inbox);
    } catch (cause) {
      if (host.current === asked) setError(cause instanceof Error ? cause.message : "The engine refused that window.");
    }
  }, [hostId]);

  return { policy, loading, save, ...(error === undefined ? {} : { error }) };
}

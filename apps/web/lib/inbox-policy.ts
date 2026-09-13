"use client";

/**
 * The inbox's standing rule, shared by the rail that bands its list by it and
 * the settings pane that changes it.
 *
 * ENGINE STATE, NOT LOCAL STORAGE: the window decides which BAND every session
 * lands in, and a per-browser copy would show one engine's two clients two
 * different inboxes.
 *
 * NOT POLLED. It changes when a person changes it, in this same app, so a window
 * event carries it and nothing needs a tick.
 *
 * ONE READ PER HOST, SHARED, and the host is part of every operation: a policy
 * belongs to the Mac that answered, so a read, a save, and the announcement that
 * follows all name the same host and none of them is applied to another
 * (docs/investigations/204-host-identity.md). Measured before this: leaving
 * Settings issued nine `/api/inbox` requests, the slowest 1.78 s.
 *
 * A SAVED VALUE OUTRANKS AN OLDER READ. A read already in flight when a save
 * lands describes the policy from before it, so it must not be written over the
 * answer the engine just gave — see `generation`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { DEFAULT_INBOX_POLICY, type InboxPolicy } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { hostFetcher, hostFromPathname, LOCAL_HOST_ID } from "@/lib/hosts/client";

/** How long a shared answer stands. The event below carries every change made
 *  in this app; this only bounds staleness for one made elsewhere. */
export const INBOX_POLICY_TTL_MS = 30_000;

type Shared = {
  policy?: InboxPolicy;
  at?: number;
  inFlight?: Promise<InboxPolicy>;
  /** Bumped by every authoritative write. A read that started under an older
   *  generation has been superseded and does not commit. */
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

/** An api pinned to one Mac. The default read/write must follow the HOST ID it
 *  was given, not the address bar — otherwise a read for `host_b` could be
 *  answered by this Mac and cached under `host_b`. */
const apiFor = (hostId: string) => createEngineApi(hostFetcher(hostId || LOCAL_HOST_ID));

/**
 * The host's policy, from one read shared by every caller.
 *
 * The fetcher is injectable so the sharing and the supersede rule are testable
 * (`inbox-policy.test.ts`).
 */
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
      // Superseded by a save while this was in the air: keep the authoritative
      // value, and hand it to this read's callers too.
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

/** Same-window propagation, with the host it belongs to: a listener looking at
 *  another Mac must ignore it rather than band its list by a stranger's rule. */
const CHANGED = "telar:inbox-policy";
type Announcement = { hostId: string; policy: InboxPolicy };

function announce(hostId: string, policy: InboxPolicy): void {
  window.dispatchEvent(new CustomEvent<Announcement>(CHANGED, { detail: { hostId, policy } }));
}

export type InboxPolicyHandle = {
  policy: InboxPolicy;
  /** True until the engine has answered once. The rail uses the default while
   *  this is true rather than showing an empty list — see below. */
  loading: boolean;
  save: (patch: { autoSettleAfterHours?: number | null; settleDelegatedAfterHours?: number | null }) => Promise<void>;
  /** The engine refused — a window outside 1..90, or an unreachable daemon. */
  error?: string;
};

/**
 * THE DEFAULT IS THE ANSWER UNTIL THE ENGINE GIVES A BETTER ONE.
 *
 * The alternative — no banding until the read lands — makes every settled row
 * appear in the live list for a beat and then vanish, which reads as a bug on
 * every single load. Being briefly wrong about a three-day-old session is not
 * something a person can even perceive.
 */
export function useInboxPolicy(): InboxPolicyHandle {
  const [policy, setPolicy] = useState<InboxPolicy>(DEFAULT_INBOX_POLICY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  /**
   * WHICH MAC, FROM THE ADDRESS BAR, and it is a dependency rather than a
   * one-time read: the policy belongs to the host, so moving between Macs
   * re-reads rather than banding the new one's rail by the old one's rule.
   */
  const pathname = usePathname();
  const hostId = hostFromPathname(pathname ?? "/");
  /** The same value for callbacks, so an answer that lands after a navigation
   *  can be dropped. Written from an effect; a ref is not render state. */
  const host = useRef(hostId);
  useEffect(() => {
    host.current = hostId;
  }, [hostId]);

  // A different Mac is a different rule: clear during render so no frame bands
  // by the Mac that was left.
  const [subject, setSubject] = useState(hostId);
  if (subject !== hostId) {
    setSubject(hostId);
    setPolicy(DEFAULT_INBOX_POLICY);
    setLoading(true);
  }

  useEffect(() => {
    const asked = hostId;
    // Deferred a tick for the same reason every other loader here is: setting
    // state from an effect BODY is the cascade the lint rule forbids, and an
    // async callback is not the effect body.
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

  const save = useCallback(async (patch: { autoSettleAfterHours?: number | null; settleDelegatedAfterHours?: number | null }) => {
    // The host is fixed here, before the request: a save that resolves after a
    // navigation must still be attributed to the Mac it was sent to.
    const asked = hostId;
    try {
      const result = await apiFor(asked).setInbox(patch);
      rememberInboxPolicy(asked, result.inbox);
      if (host.current === asked) {
        setPolicy(result.inbox);
        setError(undefined);
      }
      // ANNOUNCED FROM WHAT THE ENGINE RETURNED, never from what was sent: the
      // engine decides, and a listener told the request rather than the outcome
      // would band its list on a value that was rejected.
      announce(asked, result.inbox);
    } catch (cause) {
      if (host.current === asked) setError(cause instanceof Error ? cause.message : "The engine refused that window.");
    }
  }, [hostId]);

  return { policy, loading, save, ...(error === undefined ? {} : { error }) };
}

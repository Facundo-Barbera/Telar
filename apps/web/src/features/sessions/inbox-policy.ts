"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { DEFAULT_INBOX_POLICY, type InboxPolicy } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { hostFetcher, hostFromPathname, LOCAL_HOST_ID } from "@/platform/engine/host-client";

export const INBOX_POLICY_TTL_MS = 30_000;

type Shared = {
  policy?: InboxPolicy;
  at?: number;
  inFlight?: Promise<InboxPolicy>;
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

const apiFor = (hostId: string) => createEngineApi(hostFetcher(hostId || LOCAL_HOST_ID));

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

export function rememberInboxPolicy(hostId: string, policy: InboxPolicy, now: () => number = Date.now): void {
  const shared = sharedFor(hostId);
  shared.policy = policy;
  shared.at = now();
  shared.generation += 1;
}

export function forgetInboxPolicies(): void {
  byHost.clear();
}

const CHANGED = "telar:inbox-policy";
type Announcement = { hostId: string; policy: InboxPolicy };

function announce(hostId: string, policy: InboxPolicy): void {
  window.dispatchEvent(new CustomEvent<Announcement>(CHANGED, { detail: { hostId, policy } }));
}

export type InboxPolicyHandle = {
  policy: InboxPolicy;
  loading: boolean;
  save: (patch: { autoSettleAfterHours?: number | null; settleDelegatedAfterHours?: number | null; settledTerminalLimit?: number }) => Promise<void>;
  error?: string;
};

export function useInboxPolicy(): InboxPolicyHandle {
  const [policy, setPolicy] = useState<InboxPolicy>(DEFAULT_INBOX_POLICY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const pathname = usePathname();
  const hostId = hostFromPathname(pathname ?? "/");
  const host = useRef(hostId);
  useEffect(() => {
    host.current = hostId;
  }, [hostId]);

  const [subject, setSubject] = useState(hostId);
  if (subject !== hostId) {
    setSubject(hostId);
    setPolicy(DEFAULT_INBOX_POLICY);
    setLoading(true);
  }

  useEffect(() => {
    const asked = hostId;
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
    const asked = hostId;
    try {
      const result = await apiFor(asked).setInbox(patch);
      rememberInboxPolicy(asked, result.inbox);
      if (host.current === asked) {
        setPolicy(result.inbox);
        setError(undefined);
      }
      announce(asked, result.inbox);
    } catch (cause) {
      if (host.current === asked) setError(cause instanceof Error ? cause.message : "The engine refused that window.");
    }
  }, [hostId]);

  return { policy, loading, save, ...(error === undefined ? {} : { error }) };
}

"use client";

/**
 * The inbox's standing rule, shared by the two surfaces that care about it: the
 * rail that bands its list by it, and the settings pane that changes it.
 *
 * ENGINE STATE, NOT LOCAL STORAGE, and that is the whole reason this is a hook
 * over a fetch rather than a `localStorage` read like the theme beside it. The
 * window decides which BAND every session lands in. A per-browser copy would
 * show the desktop shell and a browser tab two different inboxes off one engine
 * — the same objection `Session.settledOverride` is on the engine to avoid.
 *
 * NOT POLLED. It changes when a person changes it, which happens in this same
 * app, so a window event carries it to the rail immediately and every other
 * client picks it up when it next mounts. Polling a preference on the sidebar's
 * 3-second cadence would be one more request per tick to learn a number that
 * changes twice a year.
 */

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_INBOX_POLICY, type InboxPolicy } from "@telar/engine-client";
import { createVNextApi } from "@/lib/vnext/client";

const api = createVNextApi();

/** Same-window propagation. A CustomEvent carrying the new policy, so a
 *  listener does not have to re-fetch what the writer already holds. */
const CHANGED = "telar:inbox-policy";

function announce(policy: InboxPolicy): void {
  window.dispatchEvent(new CustomEvent<InboxPolicy>(CHANGED, { detail: policy }));
}

export type InboxPolicyHandle = {
  policy: InboxPolicy;
  /** True until the engine has answered once. The rail uses the default while
   *  this is true rather than showing an empty list — see below. */
  loading: boolean;
  save: (patch: { autoSettleAfterDays?: number | null }) => Promise<void>;
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

  useEffect(() => {
    // Deferred a tick for the same reason every other loader here is: setting
    // state from an effect BODY is the cascade the lint rule forbids, and an
    // async callback is not the effect body.
    const task = window.setTimeout(() => {
      void api
        .inbox()
        .then((result) => setPolicy(result.inbox))
        .catch(() => undefined)
        .finally(() => setLoading(false));
    }, 0);
    const onChanged = (event: Event) => {
      const next = (event as CustomEvent<InboxPolicy>).detail;
      if (next) setPolicy(next);
    };
    window.addEventListener(CHANGED, onChanged);
    return () => {
      window.clearTimeout(task);
      window.removeEventListener(CHANGED, onChanged);
    };
  }, []);

  const save = useCallback(async (patch: { autoSettleAfterDays?: number | null }) => {
    try {
      const result = await api.setInbox(patch);
      setPolicy(result.inbox);
      setError(undefined);
      // ANNOUNCED FROM WHAT THE ENGINE RETURNED, never from what was sent: the
      // engine is what decides, and a listener told the request rather than the
      // outcome would band its list on a value that was rejected.
      announce(result.inbox);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The engine refused that window.");
    }
  }, []);

  return { policy, loading, save, ...(error === undefined ? {} : { error }) };
}

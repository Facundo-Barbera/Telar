"use client";

/**
 * THE AGENT'S SWITCH, ITS MODEL AND ITS KEY — the settings side (#531).
 *
 * A HOOK RATHER THAN LOCAL STATE, for `useSessionDefaults`' reason: the pane is
 * not the only surface that has to know, and the same-window CustomEvent
 * carries a change across without either side polling a preference that moves
 * twice a year.
 *
 * THE RAIL DOES NOT USE THIS, and that is deliberate rather than an oversight:
 * it reads `agent: { enabled }` off the live-sessions answer it already polls
 * per host per tick, so the entry costs it no request of its own. What this
 * carries is the SETTINGS side — the read that fills the pane and the writes
 * that change it. The announcement below lets a second pane in the same window
 * catch up; the rail catches up on its next poll, which is at most a few
 * seconds and needs no coordination.
 *
 * ENGINE STATE, NOT LOCAL STORAGE. This decides whether a machine HAS an Agent,
 * and a per-browser copy would mean an entry in one client's rail and not
 * another's — the exact disagreement the setting is machine-scoped to prevent.
 *
 * ── THIS HOOK IS LOCAL-ONLY, WHICH ITS PREDECESSOR WAS NOT ─────────────────
 * The coordinator hook this replaces took a `hostId`, because a paired Mac's
 * screen read its designation through it. The Agent screen reads its own state
 * off `useAgentThread` instead, and
 * Settings is scoped to the local engine — there is no `/hosts/<id>/settings`
 * route to serve. A host parameter here would be one nothing could pass.
 */

import { useCallback, useEffect, useState } from "react";
import type { AgentAnswer, AgentState } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";

const CHANGED = "telar:agent";

/** What runs when nobody picks. Shown as the field's placeholder so the row
 *  answers "what am I on right now" without a second read. Mirrors the engine's
 *  `DEFAULT_GO_MODEL`; the engine is what actually applies it. */
export const DEFAULT_AGENT_MODEL = "kimi-k3";

/** Which rung answered — never the key itself. `undefined` is an engine too old
 *  to say, which the pane must not read as "no key". */
export type AgentCredential = NonNullable<AgentAnswer["credential"]>;

export type AgentSettingsHandle = {
  agent: AgentState;
  credential?: AgentCredential;
  /** True until the engine has answered once. The pane keeps the switch
   *  disabled until then rather than offering one that might be wrong. */
  loading: boolean;
  /** By presence, like the engine's own patch: naming a model must not also
   *  re-decide the switch, and a `reset` that rode along by default would
   *  archive a conversation nobody asked to lose. */
  save: (patch: { enabled?: boolean; model?: string; reset?: boolean; apiKey?: string }) => Promise<void>;
  /** The engine refused, or is not answering. Shown on the row rather than
   *  swallowed — the engine's answer is the state. */
  error?: string;
};

/** OFF IS THE ANSWER UNTIL THE ENGINE GIVES A BETTER ONE — the default is off,
 *  so a first paint showing it on would read as "Telar did this without asking"
 *  for the length of one fetch. */
const OFF: AgentState = { enabled: false, running: false, queued: 0 };

export function useAgentSettings(): AgentSettingsHandle {
  const [agent, setAgent] = useState<AgentState>(OFF);
  const [credential, setCredential] = useState<AgentCredential>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const api = createEngineApi();
    // Deferred a tick like every other loader here: setting state from an
    // effect BODY is the cascade this app's lint forbids.
    const task = window.setTimeout(() => {
      void api
        .agent()
        .then((answer) => {
          setAgent(answer.agent);
          setCredential(answer.credential);
        })
        .catch(() => undefined)
        .finally(() => setLoading(false));
    }, 0);
    const onChanged = (event: Event) => {
      const next = (event as CustomEvent<AgentAnswer>).detail;
      if (!next) return;
      setAgent(next.agent);
      setCredential(next.credential);
    };
    window.addEventListener(CHANGED, onChanged);
    return () => {
      window.clearTimeout(task);
      window.removeEventListener(CHANGED, onChanged);
    };
  }, []);

  const save = useCallback(async (patch: { enabled?: boolean; model?: string; reset?: boolean; apiKey?: string }) => {
    try {
      const result = await createEngineApi().setAgent(patch);
      setAgent(result.agent);
      // The same answer carries it, so the pane cannot draw a switched-on Agent
      // beside a credential read from a different instant.
      setCredential(result.credential);
      setError(undefined);
      // Announced from what the ENGINE returned, never from what was sent: a
      // listener told the request rather than the outcome would show a change
      // that was refused.
      window.dispatchEvent(new CustomEvent<AgentAnswer>(CHANGED, { detail: result }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The engine refused that change.");
    }
  }, []);

  return { agent, loading, save, ...(credential === undefined ? {} : { credential }), ...(error === undefined ? {} : { error }) };
}

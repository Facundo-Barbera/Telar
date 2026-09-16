"use client";

/**
 * THE AGENT — one built-in conversation per Mac to coordinate Telar work from.
 * Experimental, off by default (#531).
 *
 * WHY IT IS A SETTING AND NOT A BUTTON ON A CONVERSATION. Whether this machine
 * HAS an Agent is a fact about the machine: every rail on every device draws
 * from it, and the phone and the desktop shell must agree. A control on a
 * session would put that decision in as many places as there are sessions.
 *
 * ── WHAT #531 TOOK OFF THIS PANE, AND WHAT IT PUT ON ────────────────────────
 * THE CONVERSATION PICKER IS GONE. Main's last row asked "which session is
 * Main", and the answer turned out to be "none of them" — the Agent is not a
 * session at all, so there is nothing to designate and nothing to pick. The
 * switch alone creates it.
 *
 * RESET ARRIVED INSTEAD, and it is the only destructive control here. It is
 * what the picker used to be for in practice: a way to start again. It is not
 * the same act — switching Main to another conversation left two, where this
 * replaces one — so it asks first.
 *
 * ── THE KEY IS THE AGENT'S OWN NOW ──────────────────────────────────────────
 * Main's key lived on a `telar` provider login, alongside every other
 * provider's credential. That login is going: the Agent is not a provider a
 * session can be created with, and a driver kind nothing can select was a menu
 * entry that led nowhere. So the key is a field on THIS document — written
 * through `PATCH /api/agent`, stored 0600 under `agent/`, and never echoed.
 *
 * THE FIELD NEVER SHOWS A STORED KEY. It shows WHETHER one is there, which is
 * what every provider login on the Providers pane does and for the same reason:
 * a field that displayed a secret would be one screen-share away from leaking
 * it. Typing a new one replaces it; the button beside it removes it.
 *
 * WHICH RUNG ANSWERED IS SHOWN, because "it works, and it is not the key you
 * pasted" is the confusing state this feature can be in — the engine falls back
 * to `OPENCODE_API_KEY` in its environment and then to the OpenCode CLI's own
 * login. The row says which, never the key.
 *
 * ── THE MODEL ROW IS BOTH A PICKER AND A FIELD ──────────────────────────────
 * `GET /api/agent/models` lists what OpenCode Go serves, and it FAILS SOFT: an
 * unreachable Go, or a machine with no key yet, answers an empty list and a
 * sentence. That is not an edge case — opening this pane BEFORE pasting a key
 * is at least as common as after, and it is exactly the state somebody is in
 * when they come here to set the Agent up.
 *
 * So the row is a dropdown when there is a list and a TEXT FIELD when there is
 * not. An empty dropdown would look broken where a field looks open, and a
 * field alone would make somebody type an id they could have picked. The id is
 * passed through untouched either way — Telar keeps no list of what Go serves,
 * and the engine is what applies the default.
 *
 * SAVE-PER-INTERACTION, AND THE ENGINE'S ANSWER IS THE STATE — the two rules
 * every settings pane here follows. A refused write leaves the controls showing
 * what is stored and says why underneath.
 */

import { useEffect, useState } from "react";
import { KeyRoundIcon, RotateCcwIcon, SparklesIcon } from "lucide-react";
import type { ProviderModel } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { DEFAULT_AGENT_MODEL, useAgentSettings } from "@/lib/agent/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dropdown, Row, SettingsGroup } from "./settings-shell";

const KEY_VAR = "OPENCODE_API_KEY";

const SOURCE_LABEL: Record<"setting" | "environment" | "cli", string> = {
  setting: "Using the key saved here.",
  environment: `No key saved here — using ${KEY_VAR} from the engine's environment.`,
  cli: "No key saved here — using the OpenCode CLI's own sign-in.",
};

export function AgentSection() {
  const { agent, credential, loading, save, error } = useAgentSettings();
  /** `undefined` until somebody types: the stored value is what shows, so a
   *  late first answer cannot overwrite a field nobody has touched — and no
   *  effect writes state, which this app's lint forbids. */
  const [typedModel, setTypedModel] = useState<string>();
  const [key, setKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  /** The confirm, held here rather than in a dialog component: one boolean, and
   *  the row already has a place to put the second button. */
  const [confirmingReset, setConfirmingReset] = useState(false);
  /** What Go serves, or nothing — see the note above on why both are ordinary.
   *  Read once when the pane opens: it costs a call to another service, and it
   *  is not something a write to this document changes. */
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [modelsMessage, setModelsMessage] = useState<string>();

  useEffect(() => {
    // Deferred a tick like every other loader on this pane.
    const task = window.setTimeout(() => {
      void createEngineApi()
        .agentModels()
        .then((answer) => {
          setModels(answer.models);
          setModelsMessage(answer.message);
        })
        // A LIST THAT DID NOT ARRIVE LEAVES THE FIELD, which is the same
        // outcome as an empty one and needs no separate state.
        .catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(task);
  }, []);

  const model = typedModel ?? agent.model ?? "";
  const hasKey = credential?.set === true;

  async function saveKey(value: string): Promise<void> {
    setKeySaved(false);
    // AN EMPTY STRING IS AN EXPLICIT CLEAR here, which is the one place this
    // departs from the provider registry's "blank never clears". There, blank
    // is indistinguishable from "I did not retype it" on a shared form; here
    // this field is the only writer of the secret and Remove has to mean it.
    await save({ apiKey: value.trim() });
    setKey("");
    if (value.trim()) setKeySaved(true);
  }

  return (
    <SettingsGroup
      title="Agent"
      description="Experimental. One built-in conversation per Mac for keeping track of Telar work — it has no project and no checkout: it reads the rail, delegates bounded tasks to sessions, and reports back."
    >
      <Row
        label="Agent (experimental)"
        icon={SparklesIcon}
        hint={
          agent.enabled
            ? "On. One entry above the session list, on every device reading this Mac. It holds the sessions and notes tools and nothing else — no shell, no browser, no files — and runs nothing on a timer."
            : "Off. The rail is unchanged and nothing is briefed. Turning it off later keeps the conversation and its history, and turning it back on resumes the same one."
        }
        {...(error ? { error } : {})}
        control={
          <Switch
            checked={agent.enabled}
            disabled={loading}
            onCheckedChange={(next: boolean) => void save({ enabled: next })}
            aria-label="Agent (experimental)"
          />
        }
      />
      <Row
        label="Model"
        hint={
          models.length > 0
            ? `What OpenCode Go serves this conversation. Empty runs ${DEFAULT_AGENT_MODEL}.`
            : `The model id OpenCode Go serves this conversation. Empty runs ${DEFAULT_AGENT_MODEL}. ${modelsMessage ?? "Its list could not be read, so type the id."}`
        }
        control={
          models.length > 0 ? (
            <Dropdown<string>
              value={model}
              label="Agent model"
              disabled={loading}
              onChange={(next) => void save({ model: next })}
              // THE DEFAULT IS AN OPTION, NOT AN ABSENCE. "Leave it to Telar" is
              // a choice somebody can come back to, and an empty string is what
              // the engine reads as "use your own default".
              options={[
                { value: "", label: `Default (${DEFAULT_AGENT_MODEL})` },
                ...models.map((entry) => ({ value: entry.id, label: entry.label || entry.id })),
              ]}
            />
          ) : (
            <Input
              className="h-8 w-56 font-mono text-xs"
              aria-label="Agent model"
              placeholder={DEFAULT_AGENT_MODEL}
              value={model}
              disabled={loading}
              onChange={(event) => setTypedModel(event.target.value)}
              // ON BLUR AND ON ENTER, not on every keystroke: a model id is
              // typed, and a PATCH per character would be a write per character.
              onBlur={() => {
                if (typedModel === undefined) return;
                setTypedModel(undefined);
                void save({ model: typedModel.trim() });
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          )
        }
      />
      <Row
        label="OpenCode Go key"
        icon={KeyRoundIcon}
        // THE ROW'S OWN STATE, beside the label rather than in the field: the
        // field shows whether a key is there by its placeholder, and this is
        // the word a reader scanning the pane sees without reading the hint.
        {...(hasKey ? { status: "set" } : {})}
        hint={
          credential === undefined
            ? "This engine does not report where its key comes from."
            : credential.source
              ? SOURCE_LABEL[credential.source]
              : `No key anywhere. Paste one here, or set ${KEY_VAR} in the engine's environment, or sign in with the OpenCode CLI.`
        }
        control={
          <div className="flex items-center gap-2">
            <Input
              type="password"
              className="h-8 w-56 font-mono text-xs"
              aria-label="OpenCode Go key"
              // NEVER THE STORED KEY — the engine hands back which rung
              // answered and nothing else, by design.
              placeholder={hasKey ? "A key is saved" : "sk-…"}
              value={key}
              disabled={loading}
              onChange={(event) => {
                setKeySaved(false);
                setKey(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && key.trim()) void saveKey(key);
              }}
            />
            {hasKey && !key.trim() ? (
              <Button variant="ghost" size="sm" disabled={loading} onClick={() => void saveKey("")}>
                Remove
              </Button>
            ) : (
              <Button size="sm" disabled={loading || !key.trim()} onClick={() => void saveKey(key)}>
                Save
              </Button>
            )}
          </div>
        }
      >
        {keySaved && <p className="mt-2 text-xs text-muted-foreground">Saved. It is stored with this Mac’s engine state and never shown again.</p>}
      </Row>
      <Row
        label="Reset conversation"
        icon={RotateCcwIcon}
        hint={
          confirmingReset
            ? "This starts a new conversation. The old one is archived beside it on this Mac, not deleted — but it will not be reachable from the Agent again."
            : "Start again with an empty thread. The Agent keeps its switch, its model and its key; only the conversation is replaced."
        }
        control={
          // IT ASKS FIRST, because it is the one control here that cannot be
          // undone from this pane. Two presses, in the row itself rather than
          // in a dialog: the question is one sentence and the hint above is
          // already where it belongs.
          confirmingReset ? (
            <div className="flex items-center gap-2">
              <Button
                variant="destructive"
                size="sm"
                disabled={loading}
                onClick={() => {
                  setConfirmingReset(false);
                  void save({ reset: true });
                }}
              >
                Reset
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmingReset(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              // NOTHING TO RESET BEFORE THERE IS A THREAD. An Agent that has
              // never been switched on has no conversation to replace.
              disabled={loading || !agent.threadId}
              onClick={() => setConfirmingReset(true)}
            >
              Reset conversation
            </Button>
          )
        }
      />
    </SettingsGroup>
  );
}

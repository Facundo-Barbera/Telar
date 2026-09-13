"use client";

/**
 * TELAR ORIENTATION — the two things the app writes into an agent's context,
 * each with a switch and one of them with its words on the page.
 *
 * WHY THIS IS A SETTING AT ALL. Everything else on this pane decides what an
 * agent may REACH: a server, a grant, a browser profile. This decides what it is
 * TOLD, in Telar's own words, before the person has said anything — and a
 * person is entitled to refuse that. Off means nothing Telar-authored is
 * injected or installed; the per-surface briefings stay, because those are tool
 * contracts (how to drive the tabs this session has) rather than orientation,
 * and turning this off must not quietly break the browser.
 *
 * THE TEXT IS READ FROM THE ENGINE, NEVER COPIED HERE. "Show the text" has to
 * show what is actually injected: a second copy in the cockpit would drift from
 * the engine's on the first edit, and a paired Mac may be running a different
 * release entirely. So the disclosure renders `text` off the same response the
 * switches came from.
 *
 * FAILURE IS SHOWN ON THE ROW, not swallowed. The engine's answer is the state,
 * so a refused write leaves the switch showing what is stored and the error
 * says why underneath — the rule the Settling rows already follow.
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { DEFAULT_AGENT_ORIENTATION, type AgentOrientation } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { Switch } from "@/components/ui/switch";
import { Row, SettingsGroup, useRestoreDefaults } from "./settings-shell";

const api = createEngineApi();

export function OrientationSection() {
  /**
   * THE DEFAULT IS THE ANSWER UNTIL THE ENGINE GIVES A BETTER ONE — the rule
   * `useInboxPolicy` states: both switches are on out of the box, so a first
   * paint that showed them off would read as "Telar is not doing this" for the
   * length of one fetch.
   */
  const [policy, setPolicy] = useState<AgentOrientation>(DEFAULT_AGENT_ORIENTATION);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [showing, setShowing] = useState(false);

  useEffect(() => {
    // Deferred a tick for the reason every other loader on this pane is:
    // setting state from an effect BODY is the cascade the lint rule forbids.
    const task = window.setTimeout(() => {
      void api
        .orientation()
        .then((answer) => {
          setPolicy(answer.orientation);
          setText(answer.text);
        })
        .catch(() => undefined)
        .finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(task);
  }, []);

  const save = useCallback(async (patch: { preamble?: boolean; skill?: boolean }) => {
    try {
      const answer = await api.setOrientation(patch);
      setPolicy(answer.orientation);
      setText(answer.text);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The engine refused that change.");
    }
  }, []);

  useRestoreDefaults(() => save({ ...DEFAULT_AGENT_ORIENTATION }));

  return (
    <SettingsGroup
      title="Telar orientation"
      description="What Telar itself writes into an agent's context, before you have said anything."
    >
      <Row
        label="Tell agents they are inside Telar"
        hint="One paragraph per turn: that “the browser” is Telar's, that a session is a Telar session, and what the panel, the rail, Spool and Looks are."
        {...(error ? { error } : {})}
        {...(policy.preamble === DEFAULT_AGENT_ORIENTATION.preamble
          ? {}
          : { onRevert: () => void save({ preamble: DEFAULT_AGENT_ORIENTATION.preamble }) })}
        control={
          <Switch
            checked={policy.preamble}
            disabled={loading}
            onCheckedChange={(next: boolean) => void save({ preamble: next })}
            aria-label="Tell agents they are inside Telar"
          />
        }
      />
      {/*
        THE DISCLOSURE IS A ROW, NOT A DIALOG. What it reveals is the exact text
        of the setting above it, and a modal would make reading it a detour from
        the decision it informs. It stays available with the switch OFF on
        purpose: "what would you inject?" is a fair question to ask before
        turning it back on.
      */}
      <Row
        label={
          <button
            type="button"
            onClick={() => setShowing((open) => !open)}
            aria-expanded={showing}
            className="flex items-center gap-1 text-left text-sm font-medium text-foreground"
          >
            <ChevronRightIcon className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${showing ? "rotate-90" : ""}`} />
            Show the text
          </button>
        }
        // SPELLED OUT because the label is a button rather than a string, so
        // `Row` cannot derive it. Must match `settingsRowId({ page: "tools",
        // group: "Telar orientation", label: "Show the text" })` exactly, or a
        // search result for it would scroll nowhere.
        id="settings-row-tools-telar-orientation-show-the-text"
      >
        {showing && (
          <p className="mt-2 whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed text-muted-foreground">
            {text || "The engine did not answer."}
          </p>
        )}
      </Row>
      <Row
        label="Install the telar skill"
        hint="A SKILL.md in each provider's skills directory, with the detail: the panel's tabs, Warps, how sessions are assigned and settled, the browser's tab rules, the Spool's verbs. Turning this off deletes it."
        {...(policy.skill === DEFAULT_AGENT_ORIENTATION.skill
          ? {}
          : { onRevert: () => void save({ skill: DEFAULT_AGENT_ORIENTATION.skill }) })}
        control={
          <Switch
            checked={policy.skill}
            disabled={loading}
            onCheckedChange={(next: boolean) => void save({ skill: next })}
            aria-label="Install the telar skill"
          />
        }
      />
    </SettingsGroup>
  );
}

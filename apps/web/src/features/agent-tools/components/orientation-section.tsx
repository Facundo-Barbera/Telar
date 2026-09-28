"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { DEFAULT_AGENT_ORIENTATION, type AgentOrientation } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { Switch } from "@/ui/switch";
import { Row, SettingsGroup, useRestoreDefaults } from "@/features/settings";

const api = createEngineApi();

export function OrientationSection() {
  const [policy, setPolicy] = useState<AgentOrientation>(DEFAULT_AGENT_ORIENTATION);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [showing, setShowing] = useState(false);

  useEffect(() => {
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
        hint="One paragraph per turn: that “the browser” is Telar's, that a session is a Telar session, and what the panel, the rail and Looks are."
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
      <Row
        label={
          <button
            type="button"
            onClick={() => setShowing((open) => !open)}
            aria-expanded={showing}
            className="flex items-center gap-1 rounded-sm text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRightIcon className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${showing ? "rotate-90" : ""}`} />
            Show the text
          </button>
        }
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
        hint="A SKILL.md in each provider's skills directory, with the detail: the panel's tabs, how sessions are assigned and settled, the browser's tab rules. Turning this off deletes it."
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

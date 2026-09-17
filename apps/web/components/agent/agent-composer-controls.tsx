"use client";

/**
 * THE AGENT'S THREE PILLS — model, effort, access (#539).
 *
 * ── WHY NOT THE SESSION COMPOSER'S OWN CONTROLS ─────────────────────────────
 * Because they are gated on a `session` this screen does not have, and the gate
 * is not an oversight: `AgentControl` takes a `ProviderDriverKind` and reads a
 * per-login provider CATALOGUE; `ReasoningControl` reads that catalogue's
 * per-model effort levels; `AccessControl` takes one of the engine's four
 * session runtime modes. The Agent has no driver, no provider instance, no
 * catalogue and no runtime mode — it has `GET /v2/agent/models`, one model id,
 * and two enums on `agent.json`.
 *
 * SO: THE SAME FURNITURE, A DIFFERENT SOURCE. `ControlTrigger`,
 * `ControlDivider`, `MenuHeading` and the two row shapes are imported from the
 * session composer rather than redrawn, because the one thing that must NOT
 * differ is what these look like. Everything behind them is the Agent's.
 *
 * ── WHERE THE VALUES LIVE ───────────────────────────────────────────────────
 * On `agent.json`, through `PATCH /v2/agent` — the same document and the same
 * route Settings writes, so the two read one value and cannot drift. There is
 * no pending/local state here: a pill writes and the state comes back.
 *
 * ── ABSENT IS NOT A DEFAULT VALUE, TWICE ────────────────────────────────────
 * An unset EFFORT means `reasoning_effort` is not sent at all — the provider's
 * own behaviour, and what every conversation did before the field existed — so
 * the row for it is "Auto" rather than a level. An unset ACCESS means `ask`,
 * which is a real default with a name, so that row says `ask`.
 */

import { useEffect, useState } from "react";
import { GaugeIcon, ShieldCheckIcon, SparklesIcon, TriangleAlertIcon } from "lucide-react";
import type { AgentModelCatalogue, AgentState } from "@telar/engine-client";
import { AgentModelList, agentModelTrouble } from "@/components/agent/agent-model-picker";
import { ChoiceRow, CompactRow, ControlDivider, ControlTrigger, MenuHeading } from "@/components/composer-controls";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { createEngineApi } from "@/lib/engine/client";
import { hostFetcher, LOCAL_HOST_ID } from "@/lib/hosts/client";

export type AgentEffort = NonNullable<AgentState["effort"]>;
export type AgentAccess = NonNullable<AgentState["access"]>;

/** What a pill writes. `""` clears, which is what the engine's patch takes. */
export type AgentControlPatch = { model?: string; effort?: string; access?: string };

const EFFORTS: AgentEffort[] = ["low", "medium", "high"];

/** Sentence case, the composer's own register. */
export const AGENT_EFFORT_LABEL: Record<AgentEffort, string> = { low: "Low", medium: "Medium", high: "High" };

export const AGENT_ACCESS_LABEL: Record<AgentAccess, string> = { ask: "Ask", auto: "Auto" };

/**
 * WHAT EACH ACCESS MODE ACTUALLY DOES, in the words a person decides on.
 *
 * The second sentence of `auto` is the one that matters and is the reason this
 * is a two-line row rather than a compact one: a reader choosing "Auto" needs
 * to know it does not widen what the Agent may do, only who says yes.
 */
export const AGENT_ACCESS_HELP: Record<AgentAccess, string> = {
  ask: "You approve each gated call — sending work to a session, creating one, stopping one, deleting a note.",
  auto: "Policy approves them and the transcript records it. The same calls are still gated; nothing new is allowed.",
};

/**
 * THE MODEL PILL — `GET /v2/agent/models`, now a described catalogue (#551).
 *
 * IT USED TO BE A FLAT LIST OF RAW IDS, because that is all the endpoint
 * answered: `{ id, object, created, owned_by }`, in Go's own order. The engine
 * merges models.dev's names and limits into it now, and a transcribed table
 * saying which of Go's three endpoints each id answers on — so the menu groups,
 * searches, and greys out the eighteen models this client cannot reach. The
 * list itself is `AgentModelList`, shared verbatim with the settings pane.
 *
 * THE PILL READS THE NAME, NOT THE ID. "Kimi K3" is what the row said when it
 * was picked; `kimi-k3` is still what goes on the wire, and the popover's rows
 * carry it in their titles for anybody who needs to see it.
 */
export function AgentModelControl({
  model,
  catalogue,
  onChange,
}: {
  model?: string;
  catalogue: AgentModelCatalogue;
  onChange?: (patch: AgentControlPatch) => void;
}) {
  const [open, setOpen] = useState(false);
  const readOnly = !onChange;
  const row = catalogue.models.find((entry) => entry.id === model);
  const label = row?.name ?? model ?? "Model";
  /**
   * THE MODEL ABOUT TO RUN IS ONE THIS CLIENT CANNOT SPEAK TO (#551).
   *
   * Reachable without going through this picker at all: typed into Settings
   * before the picker existed, set from the phone, or moved to another endpoint
   * by Go since. The pill is the last thing a person looks at before pressing
   * send, so it is where the warning belongs — the fix is one row away in the
   * menu this pill opens, and the settings pane offers it as a single press.
   */
  const trouble = agentModelTrouble(catalogue, model);
  const pick = (next: string) => {
    onChange?.({ model: next });
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <ControlTrigger
            open={open}
            // THE GLYPH CARRIES IT, not the colour alone: this pill sits in a
            // row of three, and a person who cannot tell `--warning` from
            // `--muted-foreground` would otherwise have no signal at all.
            icon={trouble ? <TriangleAlertIcon className="size-3.5 text-warning" /> : <SparklesIcon className="size-3.5" />}
            label={label}
            {...(trouble ? { title: trouble.obstacle } : {})}
            ariaLabel={trouble ? `Model: ${label} — ${trouble.obstacle}` : `Model: ${label === "Model" ? "the service default" : label}`}
            className="min-w-0 max-w-56 justify-start"
          />
        }
      />
      {/* FIXED HEIGHT, like the session picker's: the list is thirty-eight rows
          and a query narrows it to two, and a popover that re-sized under the
          pointer on every keystroke would be unusable. */}
      <PopoverContent align="start" side="top" sideOffset={8} className="h-[min(26rem,70vh)] w-72 flex-col gap-0 overflow-hidden rounded-xl p-0">
        <AgentModelList {...(model ? { model } : {})} catalogue={catalogue} readOnly={readOnly} onPick={pick} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * THE EFFORT PILL — `reasoning_effort` on the wire.
 *
 * THREE LEVELS, NOT THE PROVIDER'S OWN LIST. The session composer reads effort
 * levels per model, because a level a model does not publish fails its turn.
 * `GET /v2/agent/models` publishes ids and nothing else, so there is nothing to
 * read: low/medium/high are the values every server that honours the parameter
 * accepts, and a server that does not honour it ignores an unknown key.
 */
export function AgentEffortControl({ effort, onChange }: { effort?: AgentEffort; onChange?: (patch: AgentControlPatch) => void }) {
  const [open, setOpen] = useState(false);
  const readOnly = !onChange;
  // See ReasoningControl: an unchosen level names the QUESTION rather than
  // repeating "Auto" beside the access pill, which would be one word twice with
  // nothing to say which was which.
  const label = effort ? AGENT_EFFORT_LABEL[effort] : "Reasoning";
  const pick = (next: string) => {
    onChange?.({ effort: next });
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <ControlTrigger
            open={open}
            icon={<GaugeIcon className="size-3.5" />}
            label={label}
            ariaLabel={`Reasoning effort: ${effort ? AGENT_EFFORT_LABEL[effort] : "the model's own default"}`}
          />
        }
      />
      <PopoverContent align="start" side="top" sideOffset={8} className="w-56 gap-0 rounded-xl p-1">
        <MenuHeading>Reasoning</MenuHeading>
        {/* AUTO IS NOT A LEVEL. It means the parameter is not sent at all, which
            is what a model with no reasoning mode is served today. */}
        <CompactRow label="Auto" hint="not sent" selected={!effort} disabled={readOnly} onSelect={() => pick("")} />
        {EFFORTS.map((level) => (
          <CompactRow key={level} label={AGENT_EFFORT_LABEL[level]} selected={effort === level} disabled={readOnly} onSelect={() => pick(level)} />
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** THE ACCESS PILL — who answers the approval gate. */
export function AgentAccessControl({ access, onChange }: { access?: AgentAccess; onChange?: (patch: AgentControlPatch) => void }) {
  const [open, setOpen] = useState(false);
  const active: AgentAccess = access ?? "ask";
  const pick = (next: AgentAccess) => {
    onChange?.({ access: next });
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          // WHICH IS ACTIVE IS ON THE PILL, not only inside the menu — the issue
          // asks for it by name, and it is the setting a person most wants to
          // confirm before hitting send.
          <ControlTrigger open={open} icon={<ShieldCheckIcon className="size-3.5" />} label={AGENT_ACCESS_LABEL[active]} ariaLabel={`Access: ${AGENT_ACCESS_LABEL[active]}`} />
        }
      />
      <PopoverContent align="start" side="top" sideOffset={8} className="w-[min(22rem,calc(100vw-2rem))] gap-0 rounded-2xl p-1.5">
        <MenuHeading>Access</MenuHeading>
        {(["ask", "auto"] as AgentAccess[]).map((option) => (
          <ChoiceRow
            key={option}
            label={AGENT_ACCESS_LABEL[option]}
            description={AGENT_ACCESS_HELP[option]}
            selected={option === active}
            onSelect={() => pick(option)}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** The three, in the composer's own row grammar — hairlines between borderless
 *  labels, exactly as the session composer draws its three. */
export function AgentComposerControls({
  state,
  catalogue,
  onChange,
}: {
  state: AgentState | undefined;
  catalogue: AgentModelCatalogue;
  onChange?: (patch: AgentControlPatch) => void;
}) {
  return (
    <>
      <AgentModelControl {...(state?.model ? { model: state.model } : {})} catalogue={catalogue} {...(onChange ? { onChange } : {})} />
      <ControlDivider />
      <AgentEffortControl {...(state?.effort ? { effort: state.effort } : {})} {...(onChange ? { onChange } : {})} />
      <ControlDivider />
      <AgentAccessControl {...(state?.access ? { access: state.access } : {})} {...(onChange ? { onChange } : {})} />
    </>
  );
}

/**
 * The Agent's described model catalogue, once per screen.
 *
 * NOT `useModelCatalogue`: that is keyed by driver and login and spawns a
 * provider CLI. This is one public HTTP read with no credential — see
 * `agent/go.ts` — and it fails soft, answering an empty list and the service's
 * own words rather than throwing, because the picker is opened before the key
 * is pasted at least as often as after.
 *
 * THE EMPTY ANSWER IS SHAPED LIKE A REAL ONE, both stamps null: the picker
 * renders it during the first fetch, and a loader that had to guard every field
 * would be guarding against its own initial state rather than against the
 * engine.
 */
export const NO_AGENT_MODELS: AgentModelCatalogue = { models: [], source: { go: null, modelsDev: null } };

export function useAgentModels(hostId: string = LOCAL_HOST_ID): AgentModelCatalogue {
  const [answer, setAnswer] = useState<AgentModelCatalogue>(NO_AGENT_MODELS);
  useEffect(() => {
    let cancelled = false;
    const api = createEngineApi(hostFetcher(hostId));
    // Deferred a tick like every other loader here — setting state from an
    // effect BODY is the cascade this app's lint forbids.
    const task = window.setTimeout(() => {
      void api
        .agentModels()
        .then((next) => {
          if (!cancelled) setAnswer(next);
        })
        .catch(() => undefined);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(task);
    };
  }, [hostId]);
  return answer;
}

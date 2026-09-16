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
import { GaugeIcon, ShieldCheckIcon, SparklesIcon } from "lucide-react";
import type { AgentState, ProviderModel } from "@telar/engine-client";
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
 * THE MODEL PILL — `GET /v2/agent/models`, which is `go.ts`'s public list.
 *
 * NO CATALOGUE, NO FAMILIES, NO STARS. Those are the provider catalogue's
 * apparatus and the Agent has no provider: this is one flat list of ids from one
 * OpenAI-compatible endpoint, so the menu is that list plus the row that means
 * "whatever the service defaults to".
 */
export function AgentModelControl({
  model,
  models,
  message,
  onChange,
}: {
  model?: string;
  models: readonly ProviderModel[];
  /** The service's own words when the list could not be fetched. An empty
   *  picker carrying the reason beats one full of ids that 404. */
  message?: string;
  onChange?: (patch: AgentControlPatch) => void;
}) {
  const [open, setOpen] = useState(false);
  const readOnly = !onChange;
  const label = model ?? "Model";
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
            icon={<SparklesIcon className="size-3.5" />}
            label={label}
            ariaLabel={`Model: ${model ?? "the service default"}`}
            className="min-w-0 max-w-56 justify-start"
          />
        }
      />
      <PopoverContent align="start" side="top" sideOffset={8} className="max-h-[min(26rem,70vh)] w-64 gap-0 overflow-y-auto rounded-xl p-1">
        <MenuHeading>Model</MenuHeading>
        {/* THE DEFAULT IS A ROW, not an empty state: sending no model IS asking
            for the service's default, and a menu with nothing ticked reads as
            broken rather than unset. */}
        <CompactRow label="Default" selected={!model} disabled={readOnly} onSelect={() => pick("")} />
        {models.map((row) => (
          <CompactRow key={row.id} label={row.id} selected={model === row.id} disabled={readOnly} onSelect={() => pick(row.id)} />
        ))}
        {/* A model this list does not carry — set in Settings, or added upstream
            since. Shown, so the pill never reads as running something it is not. */}
        {model && !models.some((row) => row.id === model) && (
          <CompactRow label={model} hint="external" selected disabled onSelect={() => undefined} />
        )}
        {models.length === 0 && message && <p className="px-2 py-1.5 text-2xs leading-snug text-muted-foreground">{message}</p>}
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
  models,
  message,
  onChange,
}: {
  state: AgentState | undefined;
  models: readonly ProviderModel[];
  message?: string;
  onChange?: (patch: AgentControlPatch) => void;
}) {
  return (
    <>
      <AgentModelControl {...(state?.model ? { model: state.model } : {})} models={models} {...(message ? { message } : {})} {...(onChange ? { onChange } : {})} />
      <ControlDivider />
      <AgentEffortControl {...(state?.effort ? { effort: state.effort } : {})} {...(onChange ? { onChange } : {})} />
      <ControlDivider />
      <AgentAccessControl {...(state?.access ? { access: state.access } : {})} {...(onChange ? { onChange } : {})} />
    </>
  );
}

/**
 * The Agent's model list, once per screen.
 *
 * NOT `useModelCatalogue`: that is keyed by driver and login and spawns a
 * provider CLI. This is one public HTTP read with no credential — see
 * `agent/go.ts` — and it fails soft, answering an empty list and the service's
 * own words rather than throwing, because the picker is opened before the key
 * is pasted at least as often as after.
 */
export function useAgentModels(hostId: string = LOCAL_HOST_ID): { models: ProviderModel[]; message?: string } {
  const [answer, setAnswer] = useState<{ models: ProviderModel[]; message?: string }>({ models: [] });
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

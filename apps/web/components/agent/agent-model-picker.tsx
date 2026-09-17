"use client";

/**
 * THE AGENT'S MODEL PICKER — one list, two surfaces (#551).
 *
 * ── WHAT WAS WRONG WITH THE LIST THIS REPLACES ──────────────────────────────
 * `GET /v2/agent/models` used to answer Go's 38 raw ids in Go's own order, and
 * the picker drew exactly that: `deepseek-v4-flash-vision-exp` under
 * `deepseek-flash` under `glm-5.3-flash`, no names, no grouping, nothing to
 * type into. The complaint in #551 is the obvious consequence — "it's really
 * hard to find them" — plus a second one that looked like a missing model and
 * was not: every id IS there, and eighteen of them are on endpoints Telar's
 * Agent client cannot speak, so picking one bought a 400 halfway through a
 * turn. The engine now describes the list; this draws what it describes.
 *
 * ── THE SESSION COMPOSER'S FURNITURE, THE AGENT'S OWN SOURCE ────────────────
 * `MenuHeading`, `CompactRow`, the fixed search field above a scrolling list,
 * the arrow-key walk and the Popover are `components/composer-controls.tsx`'s,
 * imported rather than redrawn — the one thing that must NOT differ is what
 * these look like beside a session's picker.
 *
 * TWO PIECES OF THAT FURNITURE ARE DELIBERATELY NOT USED, and both would have
 * been worse here than nothing:
 *
 *   `groupFamilies` folds a catalogue by `familyKey`, which strips `[1m]` and a
 *   dated build suffix off the id an ALIAS resolves to. Go publishes neither —
 *   `glm-5.3` and `glm-5.2` resolve to nothing and share no key — so it returns
 *   38 families of one row, which is the flat list again with headings on it.
 *   The engine sends a real `family` ("GLM", "Kimi") derived from the id, and
 *   that is what this groups by. It also sends the rows already ordered,
 *   newest generation first, so the phone and the desktop cannot disagree about
 *   what "newest" means — see `agent/catalogue.ts`.
 *
 *   `ModelRowIcon` answers "which connection does this row route through", and
 *   here the answer is OpenCode Go for all 38. The same mark on every row is
 *   decoration that costs a column. The family heading is what tells the rows
 *   apart, and the ROUTE badge is the per-row fact worth a glyph's worth of
 *   space — because it is the one that decides whether the row can be picked.
 */

import { useMemo, useState } from "react";
import { CheckIcon, SearchIcon } from "lucide-react";
import type { AgentModel, AgentModelCatalogue, GoRoute } from "@telar/engine-client";
import { CompactRow, MenuHeading } from "@/components/composer-controls";
import { fmtTokens } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The list's own element id, so the search field can hand focus down to it —
 *  the session picker's trick, and the reason arrow-down works there. */
const AGENT_MODEL_LIST_ID = "agent-model-list";

/**
 * THE BADGE, IN GO'S OWN WORDS — these are the path segments
 * opencode.ai/docs/go publishes, not a paraphrase.
 *
 * `unknown` HAS NO BADGE. A row this build has not been told about is one the
 * engine is guessing chat/completions for (see `AgentModel.supported`), and a
 * badge reading "unknown" would look like a warning about the model rather than
 * an admission about Telar.
 */
export const ROUTE_LABEL: Record<GoRoute, string | undefined> = {
  chat: "chat",
  messages: "messages",
  responses: "responses",
  unknown: undefined,
};

/**
 * WHY A ROW CANNOT BE PICKED, in the words the person reads. The engine decides
 * `supported`; this is the same fact in a sentence, and the two are kept in one
 * place each so neither can drift into a half-truth.
 */
export function agentRouteObstacle(route: GoRoute): string | undefined {
  if (route === "messages") return "Not supported by Telar's Agent yet — Go serves this one in Anthropic's shape, which the Agent's chat/completions request cannot use.";
  if (route === "responses") return "Not supported by Telar's Agent yet — Go serves this one on the Responses API, which the Agent cannot send.";
  return undefined;
}

/**
 * THE MODEL THAT WILL ACTUALLY RUN, and whether Telar can run it (#551).
 *
 * ── WHY THE SURFACES NEED THIS AND NOT JUST THE LIST ────────────────────────
 * A stored model can be one this client cannot speak to, and the picker being
 * careful is not enough to prevent it: the id may have been typed into Settings
 * before the picker existed, or set from the phone, or Go may have moved it to
 * `/messages` since. The picker greys what it LISTS; this answers the question
 * the pill and the settings row have to ask about the model already chosen.
 *
 * AN ABSENT MODEL IS NOT AN ABSENT ANSWER. Storing nothing means the engine's
 * own default runs, so the default is what gets checked — and if THAT ever
 * became unsupported, the warning is exactly as urgent.
 *
 * A MODEL THE CATALOGUE DOES NOT CARRY IS NOT A PROBLEM, because nothing here
 * knows its route. It might be brand new. Warning about it would be this
 * cockpit asserting something it cannot know, which is how a picker teaches
 * people to ignore its warnings.
 */
export function agentModelTrouble(
  catalogue: AgentModelCatalogue,
  model?: string,
): { running: AgentModel; obstacle: string; switchTo?: AgentModel } | undefined {
  const running = model ? catalogue.models.find((row) => row.id === model) : catalogue.models.find((row) => row.isDefault);
  if (!running || running.supported) return undefined;
  const obstacle = agentRouteObstacle(running.route);
  if (!obstacle) return undefined;
  /** The nearest thing that WOULD run: the marked default when it is usable,
   *  otherwise the newest supported row — the catalogue already arrives in that
   *  order, so `find` is the answer rather than a second sort. */
  const switchTo = catalogue.models.find((row) => row.isDefault && row.supported) ?? catalogue.models.find((row) => row.supported);
  return { running, obstacle, ...(switchTo ? { switchTo } : {}) };
}

/**
 * WHAT A SEARCH MATCHES: the display name, the raw wire id, and the family.
 *
 * ALL THREE, because the three are what a person might know. Somebody who read
 * the release notes types "Kimi K3"; somebody who has an id in a config types
 * "kimi-k3"; somebody who just wants a GLM types "glm". Matching only the name
 * would fail the second — and the name and the id genuinely differ here
 * ("MiMo V2.5 Pro" is `mimo-v2.5-pro`).
 */
export function matchesAgentQuery(model: AgentModel, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${model.name} ${model.id} ${model.family}`.toLowerCase().includes(needle);
}

/**
 * The rows, grouped into their families IN THE ORDER THE ENGINE SENT THEM.
 *
 * Not re-sorted here: the engine already orders families by their newest member
 * and rows by release date, and a second opinion in the browser is how the
 * phone and the desktop end up listing the same catalogue differently.
 */
export function groupAgentFamilies(models: readonly AgentModel[]): { family: string; models: AgentModel[] }[] {
  const groups: { family: string; models: AgentModel[] }[] = [];
  for (const model of models) {
    const last = groups.at(-1);
    if (last && last.family === model.family) last.models.push(model);
    else groups.push({ family: model.family, models: [model] });
  }
  return groups;
}

/**
 * ONE ROW: the name, what it can hold, and where it runs.
 *
 * AN UNSUPPORTED ROW IS SHOWN, NOT HIDDEN. Dropping the eighteen would answer
 * the owner's other suspicion — that Go is withholding models — with a picker
 * that actually does withhold them. Greyed and unpressable, with the reason on
 * hover, says the true thing: the model exists, Telar cannot reach it yet.
 */
function AgentModelRow({ model, selected, readOnly, onSelect }: { model: AgentModel; selected: boolean; readOnly: boolean; onSelect: () => void }) {
  const obstacle = agentRouteObstacle(model.route);
  const disabled = readOnly || !model.supported;
  const badge = ROUTE_LABEL[model.route];
  return (
    <button
      type="button"
      data-agent-model-row
      data-model-id={model.id}
      data-unsupported={model.supported ? undefined : ""}
      disabled={disabled}
      aria-disabled={disabled}
      onClick={onSelect}
      // The wire id and the reason, for the reader who wants either. Two rows
      // can read alike ("MiMo V2.5" and "MiMo V2.5 Pro"); their ids never do.
      title={obstacle ? `${model.id} — ${obstacle}` : model.id}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
        selected ? "bg-accent" : !disabled && "hover:bg-accent/60",
        disabled && "cursor-default",
        // The greying is the UNSUPPORTED signal, so a read-only picker (no
        // write in hand) must not borrow it — that would read as eighteen
        // models becoming thirty-eight broken ones.
        !model.supported && "opacity-45",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{model.name}</span>
      {/* WHAT IT CAN HOLD, not what it costs. The context window is the fact
          that decides whether a long conversation survives on this model, and
          it is absent rather than zero on a row models.dev has not described. */}
      {model.context ? <span className="shrink-0 text-3xs tabular-nums text-muted-foreground">{fmtTokens(model.context)}</span> : null}
      {badge ? (
        <span className="max-w-20 shrink-0 truncate rounded border border-border/60 px-1 py-px text-3xs leading-4 text-muted-foreground">{badge}</span>
      ) : null}
      <span className="flex size-3.5 shrink-0 items-center justify-center">{selected && <CheckIcon className="size-3.5 text-primary" />}</span>
    </button>
  );
}

/**
 * THE ROWS, FOR ONE QUERY — everything below the search field.
 *
 * ── WHY THIS IS SEPARATE FROM THE FIELD ABOVE IT ────────────────────────────
 * The shell owns the query and this owns the list, which is the ordinary split
 * — and it is also the only way this list is testable in this suite. React 19's
 * change plugin does not see a synthesised `input` event under happy-dom (the
 * value tracker never fires, so `onChange` never runs), so a test that typed
 * into the field would assert nothing about what the list then shows. Taking
 * the query as a PROP means the search rules are tested against real rendered
 * rows rather than against a string of markup that never re-rendered.
 */
export function AgentModelRows({
  model,
  catalogue,
  query,
  readOnly,
  onPick,
}: {
  model?: string;
  catalogue: AgentModelCatalogue;
  /** What is in the search field. Empty lists everything. */
  query: string;
  readOnly?: boolean;
  onPick: (id: string) => void;
}) {
  const models = catalogue.models;
  const searching = query.trim().length > 0;
  const groups = useMemo(() => groupAgentFamilies(models.filter((row) => matchesAgentQuery(row, query))), [models, query]);
  /** The engine marks it; the row names it, so "Default" is never a row whose
   *  meaning you have to go and look up. */
  const fallback = models.find((row) => row.isDefault);

  return (
    <>
      <div
        id={AGENT_MODEL_LIST_ID}
        className="min-h-0 flex-1 overflow-y-auto p-1"
        // Arrow keys walk the pickable rows; the search field keeps the tab
        // ring. A greyed row is skipped rather than landed on and refused.
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-agent-model-row]:not([disabled])")];
          const at = rows.findIndex((row) => row === document.activeElement);
          if (at === -1) return;
          event.preventDefault();
          const next = event.key === "ArrowDown" ? Math.min(at + 1, rows.length - 1) : at - 1;
          if (next < 0) (event.currentTarget.previousElementSibling?.querySelector("input") as HTMLInputElement | null)?.focus();
          else rows[next]?.focus();
        }}
      >
        {/* THE DEFAULT IS A ROW, not an empty state: sending no model IS asking
            for the engine's default, and a menu with nothing ticked reads as
            broken rather than unset. Hidden while searching — it matches no
            query, and leaving it pinned above a filtered list makes the first
            result look like the second. */}
        {!searching && (
          <CompactRow
            label="Default"
            {...(fallback ? { hint: fallback.name } : {})}
            selected={!model}
            disabled={readOnly ?? false}
            onSelect={() => onPick("")}
          />
        )}
        {groups.map((group) => (
          <div key={group.family}>
            <MenuHeading>{group.family}</MenuHeading>
            {group.models.map((row) => (
              <AgentModelRow key={row.id} model={row} selected={model === row.id} readOnly={readOnly ?? false} onSelect={() => onPick(row.id)} />
            ))}
          </div>
        ))}
        {/* A model this list does not carry — typed into Settings, or withdrawn
            upstream since. Shown, so the pill never reads as running something
            it is not. */}
        {!searching && model && models.length > 0 && !models.some((row) => row.id === model) && (
          <CompactRow label={model} hint="external" selected disabled onSelect={() => undefined} />
        )}
        {/* Nothing to show, and the three reasons are three different
            questions: a query that matched nothing, a Go that did not answer,
            and a Go that answered with an empty list. */}
        {searching && groups.length === 0 && (
          <p className="px-2 py-1.5 text-2xs leading-snug text-muted-foreground">Nothing matches “{query.trim()}” — names and ids are searched.</p>
        )}
        {!searching && models.length === 0 && (
          <p className="px-2 py-1.5 text-2xs leading-snug text-muted-foreground">{catalogue.message ?? "OpenCode Go did not report any models."}</p>
        )}
      </div>
      {/* WHERE THE NAMES CAME FROM, and only when they did not come. A full
          list of raw ids looks like the old picker, and a person who does not
          know models.dev exists needs telling that this is a degraded state
          rather than the feature. */}
      {models.length > 0 && catalogue.source.modelsDev === null && (
        <p className="shrink-0 border-t border-border px-2.5 py-1.5 text-2xs leading-snug text-muted-foreground">
          Names and context limits come from models.dev, which could not be reached — these are OpenCode Go&apos;s ids.
        </p>
      )}
    </>
  );
}

/**
 * THE PICKER — the search field, and `AgentModelRows` under it.
 *
 * Shared by the composer pill and the Agent settings pane, which is the point:
 * #551 asks for the same picker in both, and "the same" has to mean one
 * component rather than two that were written to match on a Tuesday.
 *
 * `onPick("")` IS "use the default" — the empty string the engine's patch reads
 * as "clear the setting", unchanged from the list this replaces.
 */
export function AgentModelList({
  model,
  catalogue,
  readOnly,
  onPick,
}: {
  /** The stored id, or absent for "whatever the engine defaults to". */
  model?: string;
  catalogue: AgentModelCatalogue;
  readOnly?: boolean;
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* FIXED ABOVE THE SCROLL, part of the menu's constant chrome — the
          session picker's shape. Arrow-down hands focus to the first row. */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2.5 py-1.5">
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown") return;
            event.preventDefault();
            document.getElementById(AGENT_MODEL_LIST_ID)?.querySelector<HTMLButtonElement>("[data-agent-model-row]:not([disabled])")?.focus();
          }}
          placeholder="Search models…"
          aria-label="Search models by name or id"
          className="h-6 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
        />
        {query.trim() && (
          <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="shrink-0 rounded px-1 text-3xs text-muted-foreground hover:text-foreground">
            clear
          </button>
        )}
      </div>
      <AgentModelRows {...(model ? { model } : {})} catalogue={catalogue} query={query} {...(readOnly === undefined ? {} : { readOnly })} onPick={onPick} />
    </div>
  );
}

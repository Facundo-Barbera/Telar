"use client";

/**
 * THE PROGRAM TAB — the thesis of this whole feature.
 *
 *   *The orchestrator helps you PROGRAM the automation; it does not merely run
 *   it.*
 *
 * Everything else in the loom UI reports. This surface is where the human
 * changes what will happen tonight, and it is deliberately the only new panel
 * in the feature: the conversation beside it is a stock Telar session, and the
 * rail is a list of sessions. The one new thing is the artifact.
 *
 * ── IT IS A FILE, AND THE FILE IS ALWAYS VISIBLE ─────────────────────────────
 * `.telar/loom.md` lives in the project repo. Blocks are the comfortable way to
 * read it; "Source" is the honest one, and it is one click away at all times
 * because the artifact is meant to be read at 2am by someone working out why it
 * did something stupid. A UI that could show you a rendering but not the text
 * would be back to a config window nobody can diff.
 *
 * ── EVERY WRITE IS A SURGICAL EDIT, ROUND-TRIPPED BY THE ENGINE ──────────────
 * `PUT /api/looms/program` takes MARKDOWN. A block editor here rewrites only
 * the bytes that changed (`lib/loom-program-markdown.ts`) and re-renders from
 * the engine's response, never from what it sent — so the parser's warnings
 * arrive with the save instead of being hidden by an optimistic echo.
 *
 * ── GATES ARE NEVER A BOOLEAN ────────────────────────────────────────────────
 * Each gate shows its EXIT-CODE TABLE and the `on unknown` policy. There is no
 * pass/fail switch anywhere on this panel, because an undeclared exit code
 * means "could not verify", not "failed", and a switch cannot say that.
 */

import { useState } from "react";
import {
  BookOpenIcon,
  ChevronRightIcon,
  ClockIcon,
  FileTextIcon,
  FlaskConicalIcon,
  HandIcon,
  ListTreeIcon,
  PauseIcon,
  PlayIcon,
  ScrollTextIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TerminalIcon,
} from "lucide-react";
import type { LedgerEntry, LoomProgram, LoomProgramDoc, LoomProjectSummary, LoomRun } from "@telar/engine-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { fmtAgo } from "@/lib/format";
import { gateExitRows, UNDECLARED_EXIT_SENTENCE } from "@/lib/loom-gate";
import { dryRunLoom, ensureLoomSession, setLoomWatch } from "@/lib/loom-actions";
import { useLoomProgram } from "@/lib/loom-program";
import { useLoomLedger, useLoomWork } from "@/lib/loom-overview";
import {
  setBullets,
  setCommand,
  setGateCommand,
  setGateUnknownPolicy,
  setNotes,
  setRungEnabled,
  setWatchSchedule,
  type CommandSlot,
} from "@/lib/loom-program-markdown";
import { GateToneChip } from "./gate-chip";

/**
 * THE TAB STRIP, in `right-panel.tsx`'s idiom: a `SURFACES` array of `{id,
 * label, icon, blurb}` and a union derived from it. One entry today. The array
 * shape is what makes a second tab an addition rather than a refactor, which is
 * the whole reason that file spells it this way.
 */
const SURFACES = [
  { id: "program", label: "Program", icon: FileTextIcon, blurb: "What it will do, in your words. The file in the repo." },
  /**
   * THE LEDGER IS HERE BECAUSE THE TICK HAS NO TRANSCRIPT.
   *
   * The orchestrator session next door is a conversation. A TICK is not: it is
   * a fresh instance every time, it remembers nothing, and that is exactly why
   * cost does not ramp with uptime. So "what did it do at 3am" has no chat to
   * open, and offering one would be an affordance with nothing behind it. This
   * append-only journal is what an agent that deliberately does not remember
   * leaves behind, and it belongs where a person would have looked for the
   * conversation.
   */
  { id: "ledger", label: "Ledger", icon: ScrollTextIcon, blurb: "What the ticks did. A tick keeps no transcript; this is the record." },
] as const;

type PanelTab = (typeof SURFACES)[number]["id"];

/** The four slots and what each one is handed. Substitution is literal `$NAME`
 *  replacement into a string run through the shell — the same trust level as a
 *  `package.json` script, and the reason the vars are shown rather than hidden. */
const SLOTS: { id: CommandSlot; label: string; vars: string[]; contract: string }[] = [
  {
    id: "probe",
    label: "probe",
    vars: [],
    contract: "One cheap line to stdout. That line is the fingerprint. No model runs. A non-zero exit means “unknown, do not wake”.",
  },
  { id: "list", label: "list", vars: [], contract: "Prints the candidate work items, however this project wants to." },
  { id: "detail", label: "detail", vars: ["$ITEM"], contract: "Everything needed to understand one item." },
  {
    id: "publish",
    label: "publish",
    vars: ["$BRANCH", "$TITLE", "$BODY", "$BASE"],
    contract: "Makes the work visible. Exit 0 means published; the first URL on stdout is recorded.",
  },
];

export function ProgramPanel({ project, now = 0 }: { project?: LoomProjectSummary; now?: number }) {
  const projectId = project?.projectId;
  const { doc, loading, saving, error, save } = useLoomProgram(projectId);
  const [tab, setTab] = useState<PanelTab>("program");
  const [showSource, setShowSource] = useState(false);
  const assumed = doc?.program?.assumed ?? [];

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-border/70 bg-muted/20">
      <div className="flex shrink-0 items-center gap-3 border-b border-border/70 px-3 pt-2 text-[11px]">
        {SURFACES.map((surface) => (
          <button
            key={surface.id}
            type="button"
            title={surface.blurb}
            onClick={() => setTab(surface.id)}
            className={`-mb-px flex items-center gap-1.5 pb-1.5 ${
              tab === surface.id ? "border-b-2 border-primary font-medium text-foreground" : "text-muted-foreground/60"
            }`}
          >
            <surface.icon className="size-3" />
            {surface.label}
          </button>
        ))}
        {/* §4.4 — an assumption you can see is survivable. The badge is how it
            stays visible from a panel that is not open. */}
        {assumed.length > 0 && (
          <Badge variant="outline" className="mb-1 ml-auto h-4 px-1.5 text-[10px]">
            {assumed.length} assumed
          </Badge>
        )}
        {tab === "program" && (
          <button
            type="button"
            onClick={() => setShowSource(!showSource)}
            className={`mb-1 ${assumed.length > 0 ? "" : "ml-auto"} rounded px-1.5 py-0.5 text-[10px] ${
              showSource ? "bg-accent text-foreground" : "text-muted-foreground/70 hover:text-foreground"
            }`}
          >
            Source
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
        {tab === "program" && loading && <p className="text-[11px] text-muted-foreground">Reading the Program…</p>}
        {!loading && !projectId && <p className="text-[11px] text-muted-foreground">No project selected.</p>}
        {error && <p className="rounded-md bg-destructive/10 px-2 py-1 text-[11px] text-destructive">{error}</p>}

        {tab === "program" && doc && !doc.exists && (
          <div className="rounded-lg border border-info/40 bg-info/5 px-2.5 py-2">
            <p className="text-[11px] leading-relaxed">
              There is no Program at <span className="font-mono">{doc.path}</span> yet. Everything below is the
              default. Ask the orchestrator to draft one — it looks at the project first and asks only about what it
              cannot determine.
            </p>
          </div>
        )}

        {tab === "program" && doc?.warnings && doc.warnings.length > 0 && (
          <div className="rounded-lg border border-warning/40 bg-warning/5 px-2.5 py-2">
            <p className="text-[11px] font-medium text-warning">The parser degraded {doc.warnings.length} thing(s):</p>
            <ul className="mt-1 space-y-0.5">
              {doc.warnings.map((warning) => (
                <li key={warning} className="text-[10px] leading-relaxed text-muted-foreground">
                  {warning}
                </li>
              ))}
            </ul>
          </div>
        )}

        {tab === "ledger" ? (
          <Ledger projectId={projectId} />
        ) : showSource ? (
          <SourceBlock key={doc?.markdown ?? ""} doc={doc} saving={saving} onSave={save} />
        ) : (
          doc && <Blocks doc={doc} program={doc.program} saving={saving} onSave={save} project={project} now={now} />
        )}
      </div>
    </aside>
  );
}

function Blocks({
  doc,
  program,
  saving,
  onSave,
  project,
  now,
}: {
  doc: LoomProgramDoc;
  program: LoomProgram | null;
  saving: boolean;
  onSave: (markdown: string) => Promise<boolean>;
  project?: LoomProjectSummary;
  now: number;
}) {
  const markdown = doc.markdown;
  return (
    <>
      <Block icon={TerminalIcon} title="Where work comes from" sub="four commands, no integration">
        <p className="mb-1.5 text-[10px] leading-relaxed text-muted-foreground/80">
          These run on your machine, unattended. Substitution is literal <span className="font-mono">$NAME</span>{" "}
          replacement into the string.
        </p>
        {SLOTS.map((slot) => (
          /* KEYED ON THE SAVED VALUE, which is React's own answer to "reset
             this component's state when a prop changes": a save remounts the
             editor with the engine's canonical text, and typing — which does
             not change `value` — never disturbs it. An effect that pushed the
             prop into state would be a cascading render, and this app lints
             it. */
          <CommandSlotEditor
            key={`${slot.id}:${program?.commands[slot.id] ?? ""}`}
            slot={slot}
            value={program?.commands[slot.id] ?? ""}
            saving={saving}
            onSave={(next) => onSave(setCommand(markdown, slot.id, next))}
          />
        ))}
      </Block>

      <Block icon={BookOpenIcon} title="How to read one" sub="prose, handed to the agent verbatim">
        <ProseEditor
          key={program?.notes ?? ""}
          value={program?.notes ?? ""}
          placeholder="e.g. the newest thing said wins over the original text; read the polarity of a dependency before treating it as a blocker."
          saving={saving}
          onSave={(next) => onSave(setNotes(markdown, next))}
        />
      </Block>

      <Block icon={ShieldCheckIcon} title="What must pass" sub={`${program?.gates.length ?? 0} gate(s)`}>
        {(program?.gates ?? []).length === 0 ? (
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            No gate declared, so nothing is verified before publishing. Add one in Source, or ask the orchestrator to
            find the check this project already has.
          </p>
        ) : (
          (program?.gates ?? []).map((gate, index) => (
            <GateBlock
              key={`${index}:${gate.command}:${gate.onUnknown}`}
              gate={gate}
              index={index}
              saving={saving}
              onCommand={(next) => onSave(setGateCommand(markdown, index, next))}
              onPolicy={(policy) => onSave(setGateUnknownPolicy(markdown, index, policy))}
            />
          ))
        )}
      </Block>

      <Block icon={ListTreeIcon} title="When stuck" sub="the ladder — tried in order, each once">
        <p className="mb-1.5 text-[10px] leading-relaxed text-muted-foreground/80">
          Escalations go to the orchestrator first. Past the last rung that is on, the loom waits for you.
        </p>
        {(program?.ladder ?? []).length === 0 ? (
          <p className="text-[10px] text-muted-foreground">No rungs. Anything that stalls reaches you immediately.</p>
        ) : (
          <div className="space-y-1">
            {[...(program?.ladder ?? [])]
              .sort((left, right) => left.n - right.n)
              .map((rung) => (
                <div key={rung.n} className="flex items-center gap-2">
                  <span className="w-3 shrink-0 font-mono text-[10px] text-muted-foreground/50">{rung.n}</span>
                  <span
                    className={`min-w-0 flex-1 text-[11px] ${rung.enabled ? "text-foreground" : "text-muted-foreground/50 line-through"}`}
                  >
                    {rung.label}
                  </span>
                  {/* THE ABSORBED COUNT IS THE POINT. It is the only number that
                      tells the human whether their ladder is any good, so it is
                      never hidden behind a disclosure. */}
                  <span
                    className={`shrink-0 font-mono text-[10px] ${rung.absorbed > 0 ? "text-success" : "text-muted-foreground/40"}`}
                    title={`This rung has resolved ${rung.absorbed} stuck loom(s).`}
                  >
                    {rung.absorbed > 0 ? `absorbed ${rung.absorbed}` : "absorbed 0"}
                  </span>
                  <Switch
                    size="sm"
                    checked={rung.enabled}
                    disabled={saving}
                    onCheckedChange={(checked: boolean) => void onSave(setRungEnabled(markdown, rung.n, checked))}
                  />
                </div>
              ))}
            <div className="flex items-center gap-2 border-t border-border/50 pt-1">
              <HandIcon className="size-2.5 shrink-0 text-warning" />
              <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">then it asks you</span>
            </div>
          </div>
        )}
      </Block>

      <Block icon={HandIcon} title="Ask me only when" sub="the last valve">
        <ProseEditor
          key={(program?.askWhen ?? []).join("\n")}
          value={(program?.askWhen ?? []).join("\n")}
          placeholder="One condition per line."
          saving={saving}
          onSave={(next) => onSave(setBullets(markdown, "ask-when", next.split("\n")))}
        />
      </Block>

      <Block icon={ClockIcon} title="When to look" sub="idle is free">
        <ScheduleEditor
          key={`${program?.watch.intervalSec ?? 300}:${program?.watch.backoffMaxSec ?? 3600}`}
          intervalSec={program?.watch.intervalSec ?? 300}
          backoffMaxSec={program?.watch.backoffMaxSec ?? 3600}
          saving={saving}
          onSave={(interval, backoff) => onSave(setWatchSchedule(markdown, interval, backoff))}
        />
        {project && <LiveWatch project={project} now={now} />}
      </Block>

      {(program?.assumed ?? []).length > 0 && (
        <Block icon={SparklesIcon} title="Assumed — confirm" sub="what setup guessed" tone="info">
          <p className="mb-1.5 text-[10px] leading-relaxed text-muted-foreground/80">
            A wrong assumption you can see is survivable; an invisible one is not.
          </p>
          <ul className="space-y-1">
            {(program?.assumed ?? []).map((assumption) => (
              <li key={assumption} className="text-[11px] leading-relaxed">
                {assumption}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[10px] text-muted-foreground/70">
            Confirm or correct these on the deck, where everything blocked on a person lives.
          </p>
        </Block>
      )}

      {project && <DryRun project={project} />}
    </>
  );
}

function Block({
  icon: Icon,
  title,
  sub,
  tone = "plain",
  children,
}: {
  icon: React.ElementType;
  title: string;
  sub?: string;
  tone?: "plain" | "info";
  children: React.ReactNode;
}) {
  return (
    <section
      className={`overflow-hidden rounded-lg border bg-card ${tone === "info" ? "border-info/40" : "border-border/70"}`}
    >
      <div className="flex items-baseline gap-1.5 px-2.5 py-1.5">
        <Icon className="size-3 shrink-0 translate-y-0.5 text-muted-foreground" />
        <span className="text-[12px] font-medium">{title}</span>
        {sub && <span className="truncate text-[10px] text-muted-foreground/70">{sub}</span>}
      </div>
      <div className="px-2.5 pb-2">{children}</div>
    </section>
  );
}

/** One command slot: the string, its substitution vars, and its contract. */
function CommandSlotEditor({
  slot,
  value,
  saving,
  onSave,
}: {
  slot: (typeof SLOTS)[number];
  value: string;
  saving: boolean;
  onSave: (next: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);

  return (
    <div className="mt-1.5 first:mt-0">
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[10px] font-medium text-foreground/80">{slot.label}</span>
        {slot.vars.map((name) => (
          <span key={name} className="rounded bg-muted px-1 font-mono text-[9px] text-muted-foreground">
            {name}
          </span>
        ))}
        {value === "" && <span className="text-[9px] text-muted-foreground/60">not set</span>}
      </div>
      {editing ? (
        <div className="mt-1 space-y-1">
          <Textarea
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-10 font-mono text-[11px]"
          />
          <div className="flex gap-1">
            <Button
              size="sm"
              className="h-5 px-1.5 text-[10px]"
              disabled={saving}
              onClick={() => void onSave(draft).then((ok) => ok && setEditing(false))}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-5 px-1.5 text-[10px]"
              onClick={() => {
                setDraft(value);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="mt-0.5 block w-full rounded bg-muted/50 px-1.5 py-1 text-left font-mono text-[10px] leading-relaxed break-all whitespace-pre-wrap text-muted-foreground hover:bg-muted"
        >
          {value === "" ? "click to set" : value}
        </button>
      )}
      <p className="mt-0.5 text-[9px] leading-relaxed text-muted-foreground/60">{slot.contract}</p>
    </div>
  );
}

/**
 * ONE GATE, ALWAYS AS A TABLE.
 *
 * The exit codes are what this project says they mean, and every code it did
 * NOT declare falls through to "could not verify" — never to "failed", because
 * assuming POSIX convention is exactly the imposition this design exists to
 * avoid, and it is wrong in both directions.
 */
function GateBlock({
  gate,
  index,
  saving,
  onCommand,
  onPolicy,
}: {
  gate: LoomProgram["gates"][number];
  index: number;
  saving: boolean;
  onCommand: (next: string) => Promise<boolean>;
  onPolicy: (policy: "hold" | "publish") => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(gate.command);
  const [editing, setEditing] = useState(false);
  const rows = gateExitRows(gate);

  return (
    <div className="mt-2 first:mt-0">
      {editing ? (
        <div className="space-y-1">
          <Textarea
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-9 font-mono text-[11px]"
          />
          <div className="flex gap-1">
            <Button
              size="sm"
              className="h-5 px-1.5 text-[10px]"
              disabled={saving}
              onClick={() => void onCommand(draft).then((ok) => ok && setEditing(false))}
            >
              Save
            </Button>
            <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[10px]" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="block w-full rounded bg-muted/50 px-1.5 py-1 text-left font-mono text-[10px] break-all text-muted-foreground hover:bg-muted"
        >
          {gate.command}
        </button>
      )}

      <div className="mt-1 space-y-0.5">
        {rows.map((row) => (
          <div key={row.code} className="flex items-center gap-2">
            <span className="w-8 shrink-0 font-mono text-[10px] text-muted-foreground/60">exit {row.code}</span>
            <GateToneChip tone={row.outcome} />
          </div>
        ))}
        <p className="text-[9px] text-muted-foreground/60">{UNDECLARED_EXIT_SENTENCE}</p>
      </div>

      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="text-[10px] text-muted-foreground">on could-not-verify</span>
        {(["hold", "publish"] as const).map((policy) => (
          <button
            key={policy}
            type="button"
            disabled={saving}
            onClick={() => void onPolicy(policy)}
            className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
              gate.onUnknown === policy
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            {policy}
          </button>
        ))}
        <span className="text-[9px] text-muted-foreground/60" title={`gate ${index + 1}`}>
          {gate.onUnknown === "hold" ? "a PR you did not get" : "possibly red CI"}
        </span>
      </div>
    </div>
  );
}

function ProseEditor({
  value,
  placeholder,
  saving,
  onSave,
}: {
  value: string;
  placeholder: string;
  saving: boolean;
  onSave: (next: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(value);
  const [dirty, setDirty] = useState(false);

  return (
    <div className="space-y-1">
      <Textarea
        value={draft}
        placeholder={placeholder}
        onChange={(event) => {
          setDraft(event.target.value);
          setDirty(true);
        }}
        className="min-h-14 text-[11px] leading-relaxed"
      />
      {dirty && (
        <div className="flex gap-1">
          <Button size="sm" className="h-5 px-1.5 text-[10px]" disabled={saving} onClick={() => void onSave(draft)}>
            Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1.5 text-[10px]"
            onClick={() => {
              setDraft(value);
              setDirty(false);
            }}
          >
            Revert
          </Button>
        </div>
      )}
    </div>
  );
}

function ScheduleEditor({
  intervalSec,
  backoffMaxSec,
  saving,
  onSave,
}: {
  intervalSec: number;
  backoffMaxSec: number;
  saving: boolean;
  onSave: (interval: number, backoff: number) => Promise<boolean>;
}) {
  const [interval, setInterval] = useState(String(intervalSec));
  const [backoff, setBackoff] = useState(String(backoffMaxSec));
  const dirty = interval !== String(intervalSec) || backoff !== String(backoffMaxSec);
  const valid = Number(interval) > 0 && Number(backoff) > 0;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className="text-muted-foreground">every</span>
        <input
          value={interval}
          inputMode="numeric"
          onChange={(event) => setInterval(event.target.value)}
          className="w-14 rounded border border-input bg-transparent px-1 py-0.5 text-right font-mono text-[11px] outline-none focus-visible:border-ring"
        />
        <span className="text-muted-foreground">s, backing off to</span>
        <input
          value={backoff}
          inputMode="numeric"
          onChange={(event) => setBackoff(event.target.value)}
          className="w-16 rounded border border-input bg-transparent px-1 py-0.5 text-right font-mono text-[11px] outline-none focus-visible:border-ring"
        />
        <span className="text-muted-foreground">s</span>
      </div>
      <p className="text-[9px] leading-relaxed text-muted-foreground/60">
        The interval doubles after each quiet probe and resets on any change. A probe costs one command and no model,
        so a silent night is free.
      </p>
      {dirty && (
        <Button
          size="sm"
          className="h-5 px-1.5 text-[10px]"
          disabled={saving || !valid}
          onClick={() => void onSave(Number(interval), Number(backoff))}
        >
          Save
        </Button>
      )}
    </div>
  );
}

/** What the sentinel is doing RIGHT NOW — the runtime counterpart to the
 *  schedule above it, and the one control that arms or disarms it. */
function LiveWatch({ project, now }: { project: LoomProjectSummary; now: number }) {
  const [busy, setBusy] = useState(false);
  const watch = project.watch;

  return (
    <div className="mt-2 space-y-1 border-t border-border/50 pt-1.5">
      <div className="flex items-center gap-1.5">
        <span
          className={`size-1.5 shrink-0 rounded-full ${watch.running ? "animate-pulse bg-success" : "bg-muted-foreground/40"}`}
        />
        <span className="text-[10px] text-muted-foreground">
          {watch.running ? "watching" : "paused"}
          {watch.quietChecks > 0 ? ` · ${watch.quietChecks} quiet checks deep` : ""}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-5 px-1.5 text-[10px]"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void setLoomWatch(project.projectId, !watch.running).finally(() => setBusy(false));
          }}
        >
          {watch.running ? <PauseIcon className="size-2.5" /> : <PlayIcon className="size-2.5" />}
          {watch.running ? "Pause" : "Run"}
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-x-2 text-[9px] text-muted-foreground/70">
        <span>last probe {watch.lastProbeAt && now ? fmtAgo(watch.lastProbeAt, now) : "—"}</span>
        <span>next probe {watch.nextProbeAt && now ? describeNext(watch.nextProbeAt, now) : "—"}</span>
        <span>last change {watch.lastChangeAt && now ? fmtAgo(watch.lastChangeAt, now) : "—"}</span>
      </div>
      {watch.lastError && <p className="text-[9px] leading-relaxed text-warning">{watch.lastError}</p>}
    </div>
  );
}

function describeNext(at: number, now: number): string {
  const seconds = Math.round((at - now) / 1000);
  if (seconds <= 0) return "due";
  if (seconds < 60) return `in ${seconds}s`;
  return `in ${Math.round(seconds / 60)}m`;
}

/**
 * THE DRY RUN — the trust surface.
 *
 * A real tick that dispatches nothing: what it WOULD do right now, and, more
 * usefully, what it noticed that you did not say. It costs almost nothing and
 * happens before a line of code is written, which is what makes it the thing to
 * press after every correction rather than a one-time setup step.
 */
function DryRun({ project }: { project: LoomProjectSummary }) {
  const work = useLoomWork();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const run = work.latest(project.projectId, "dry-run");
  const running = run?.state === "running";

  return (
    <section className="overflow-hidden rounded-lg border border-border/70 bg-card">
      <div className="flex items-baseline gap-1.5 px-2.5 py-1.5">
        <FlaskConicalIcon className="size-3 shrink-0 translate-y-0.5 text-muted-foreground" />
        <span className="text-[12px] font-medium">Dry run</span>
        <span className="truncate text-[10px] text-muted-foreground/70">nothing is dispatched</span>
        <Button
          size="sm"
          className="ml-auto h-5 px-1.5 text-[10px]"
          disabled={busy || running}
          onClick={() => {
            setBusy(true);
            void dryRunLoom(project.projectId).then((result) => {
              setBusy(false);
              if (result.ok) work.began();
              else setFailed(result.error);
            });
          }}
        >
          {running ? "Running…" : "Run it"}
        </Button>
      </div>
      <div className="px-2.5 pb-2">
        {failed && <p className="text-[10px] text-destructive">{failed}</p>}
        {!run && !failed && (
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            Shows what it would do right now against live data — including the thing you did not think to say. Press
            it after every correction.
          </p>
        )}
        {run && <RunReport run={run} />}
      </div>
    </section>
  );
}

function RunReport({ run }: { run: LoomRun }) {
  const decision = run.decision;
  return (
    <div className="space-y-1.5">
      {run.state === "running" && <p className="text-[10px] text-info">{run.step ?? "thinking…"}</p>}
      {run.state === "failed" && <p className="text-[10px] text-destructive">{run.error ?? "The run failed."}</p>}
      {run.note && <p className="text-[11px] leading-relaxed">{run.note}</p>}

      {decision && decision.dispatch.length > 0 && (
        <div>
          <p className="text-[10px] font-medium text-muted-foreground">would dispatch</p>
          {decision.dispatch.map((item) => (
            <div key={item.item} className="flex items-baseline gap-1.5">
              <span className="max-w-[6rem] shrink-0 truncate font-mono text-[10px] text-muted-foreground">
                {item.item}
              </span>
              <span className="min-w-0 flex-1 truncate text-[10px]">{item.title}</span>
            </div>
          ))}
        </div>
      )}

      {decision && decision.triage.length > 0 && (
        <div>
          <p className="text-[10px] font-medium text-muted-foreground">would classify {decision.triage.length}</p>
          {decision.triage.slice(0, 8).map((entry) => (
            <div key={entry.item} className="flex items-baseline gap-1.5">
              <span className="max-w-[6rem] shrink-0 truncate font-mono text-[10px] text-muted-foreground">
                {entry.item}
              </span>
              <span className="shrink-0 font-mono text-[9px] text-muted-foreground/60">{entry.classification}</span>
              <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{entry.reason}</span>
            </div>
          ))}
        </div>
      )}

      {/* THE POINT OF THE WHOLE EXERCISE: what it noticed that you did not say. */}
      {decision && decision.ask.length > 0 && (
        <div className="rounded border border-warning/40 bg-warning/5 px-1.5 py-1">
          <p className="text-[10px] font-medium text-warning">it would ask you</p>
          {decision.ask.map((ask, index) => (
            <p key={`${ask.question}:${index}`} className="mt-0.5 text-[10px] leading-relaxed">
              {ask.question}
              {ask.why && <span className="text-muted-foreground"> — {ask.why}</span>}
            </p>
          ))}
        </div>
      )}

      {decision && decision.park.length > 0 && (
        <div>
          <p className="text-[10px] font-medium text-muted-foreground">would park {decision.park.length}</p>
        </div>
      )}
    </div>
  );
}

/**
 * THE ARTIFACT, RAW. Always one click away, because it is meant to be read at
 * 2am and the human must always be able to see exactly what it says — including
 * the prose the block editor above deliberately does not claim.
 */
function SourceBlock({
  doc,
  saving,
  onSave,
}: {
  doc?: LoomProgramDoc;
  saving: boolean;
  onSave: (markdown: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(doc?.markdown ?? "");
  const [dirty, setDirty] = useState(false);

  return (
    <section className="space-y-1">
      <div className="flex items-baseline gap-1.5">
        <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/50" />
        <span className="truncate font-mono text-[10px] text-muted-foreground">{doc?.path ?? ".telar/loom.md"}</span>
      </div>
      <Textarea
        value={draft}
        spellCheck={false}
        onChange={(event) => {
          setDraft(event.target.value);
          setDirty(true);
        }}
        className="min-h-[24rem] font-mono text-[10px] leading-relaxed"
      />
      <div className="flex gap-1">
        <Button size="sm" className="h-5 px-1.5 text-[10px]" disabled={saving || !dirty} onClick={() => void onSave(draft)}>
          Save the file
        </Button>
        {dirty && (
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1.5 text-[10px]"
            onClick={() => {
              setDraft(doc?.markdown ?? "");
              setDirty(false);
            }}
          >
            Revert
          </Button>
        )}
      </div>
      <p className="text-[9px] leading-relaxed text-muted-foreground/60">
        The engine parses this and renders it back, so what you see after a save is what it actually understood. An
        unknown heading is kept as prose, never an error.
      </p>
    </section>
  );
}

/**
 * THE LEDGER, DRAWN AS A NARRATIVE.
 *
 * One line per thing that happened, newest last, the way it was written. It is
 * deliberately coarse — 40 lines a tick, read by a person, not a metrics
 * stream — and it is the only record a headless tick leaves.
 */
function Ledger({ projectId }: { projectId?: string }) {
  const { entries, loading } = useLoomLedger(projectId, true);
  if (!projectId) return <p className="text-[11px] text-muted-foreground">No project selected.</p>;
  if (loading && entries.length === 0) return <p className="text-[11px] text-muted-foreground">Reading the ledger…</p>;
  if (entries.length === 0) {
    return (
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Nothing yet. A tick appends here; it keeps no conversation of its own, so this and the dry run are the whole
        record of what it did.
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <p className="text-[9px] leading-relaxed text-muted-foreground/60">
        A tick is a fresh instance every time and remembers nothing. This is what it left behind.
      </p>
      {entries.map((entry, index) => (
        <LedgerRow key={`${entry.at}:${index}`} entry={entry} />
      ))}
    </div>
  );
}

function LedgerRow({ entry }: { entry: LedgerEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded border border-border/60 bg-card px-1.5 py-1">
      <button
        type="button"
        disabled={!entry.detail}
        onClick={() => setOpen(!open)}
        className="flex w-full items-baseline gap-1.5 text-left"
      >
        <span className="w-12 shrink-0 font-mono text-[9px] text-muted-foreground/60">{entry.kind}</span>
        <span className="min-w-0 flex-1 text-[10px] leading-relaxed">{entry.summary}</span>
        {entry.item && <span className="max-w-[5rem] shrink-0 truncate font-mono text-[9px] text-muted-foreground/50">{entry.item}</span>}
      </button>
      {open && entry.detail && (
        <p className="mt-1 border-l border-border/60 pl-1.5 text-[9px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {entry.detail}
        </p>
      )}
    </div>
  );
}

/**
 * THE SETUP INVITATION — and the ONLY thing in this vertical that starts an
 * orchestrator session.
 *
 * IT SAYS WHAT PRESSING IT DOES, BEFORE IT DOES IT. The dry run is the design's
 * trust surface precisely because it shows what WOULD happen before anything is
 * spent; a setup button that quietly launched an agent would undo that lesson in
 * miniature. So the sentence below names the three facts a person needs in
 * advance: a session starts, it goes and reads the project, and that costs
 * something.
 *
 * It is a BUTTON rather than a link for the same reason. `/looms/[projectId]`
 * deliberately does not create anything by being opened — see the orchestrator's
 * own note — because the person browsing the deck at 2am to find out what
 * happened overnight must not be billed for looking.
 */
function SetupInvitation({
  project,
  onStarted,
}: {
  project: LoomProjectSummary;
  onStarted: (sessionId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();

  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2.5 px-8 text-center">
      <SparklesIcon className="size-5 text-muted-foreground/40" />
      <h2 className="text-[14px] font-semibold tracking-tight">Nothing is orchestrating {project.name} yet</h2>
      <p className="max-w-sm text-[12px] leading-relaxed text-muted-foreground">
        Setting it up is a conversation, not a form. You say what you want watched; it looks at the project first —
        the base branch, the check it already runs, how this project declares work — and asks only about what it
        genuinely cannot determine.
      </p>
      <p className="max-w-sm text-[11px] leading-relaxed text-muted-foreground/70">
        Its output is one file, <span className="font-mono">{project.programPath}</span>, and a dry run showing what
        it would do right now. It does not change anything else in the repo.
      </p>
      <Button
        size="sm"
        className="mt-1"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void ensureLoomSession(project.projectId).then((result) => {
            setBusy(false);
            if (result.ok) onStarted(result.data.sessionId);
            else setFailed(result.error);
          });
        }}
      >
        {busy ? "Starting…" : "Start the conversation"}
      </Button>
      {/* THE HONEST LABEL UNDER THE BUTTON. Nothing in this UI spends money
          without a human pressing something, and the thing they press has to
          say so. */}
      <p className="max-w-xs text-[10px] leading-relaxed text-muted-foreground/60">
        This starts a session that goes and reads the project, so it costs tokens. Nothing runs until you press it,
        and nothing is dispatched until you have seen a dry run.
      </p>
      {failed && <p className="text-[11px] text-destructive">{failed}</p>}
    </div>
  );
}

export { SetupInvitation };

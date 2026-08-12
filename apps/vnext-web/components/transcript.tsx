"use client";

import { useMemo, useState } from "react";
import type { Item } from "@telar/engine-client";
import { isToolItem, itemLabel, itemText, toolOutput, type JournalItem, type JournalTask } from "@/lib/vnext/journal";
import { AgentMarkdown } from "./agent-markdown";
import { Icon, type IconName } from "./vnext-icons";

/**
 * The activity lane.
 *
 * FOUR RULES CARRIED OVER FROM THE FROZEN COCKPIT, each of which the first
 * rebuild broke:
 *
 * 1. A TOOL ROW IS A ROW, NOT A CARD. 12px quiet text on transparent, with a
 *    hairline indent for nesting. Boxing each call reads as a heavier, busier
 *    app and makes a long turn a stack of containers.
 * 2. A LIVE TURN SHOWS ONE STEP. An agent running forty commands must not push
 *    the composer off the screen, so while a turn streams only the newest step
 *    is visible behind a `+N earlier steps` toggle. This is the single biggest
 *    readability decision in the original.
 * 3. A SETTLED TURN FOLDS ITS WORK. History reads as conclusions: the finished
 *    turn shows its closing prose, and everything that produced it collapses to
 *    one line — `16 steps · Ran command ×12 · Read file ×2`.
 * 4. ERRORS SURVIVE COLLAPSE. A fold hiding a failure carries the failure's
 *    colour and mark, or a turn that failed and then said something reassuring
 *    reads as clean history.
 *
 * The one place this deliberately DIVERGES from the original is the diff: the
 * frozen app had no diff renderer at all — an Edit expanded to escaped JSON —
 * and the engine now produces real patches, so we render them.
 */

const TOOL_ICON: Partial<Record<Item["detail"]["type"], IconName>> = {
  command_execution: "terminal",
  file_read: "file",
  file_change: "pencil",
  web_search: "globe",
  browser_action: "globe",
  mcp_tool_call: "wrench",
  dynamic_tool_call: "wrench",
};

/** The verb a row leads with. Past tense: the transcript is a record. */
function actionLabel(item: JournalItem): string {
  switch (item.detail.type) {
    case "command_execution":
      return "Ran command";
    case "file_read":
      return "Read file";
    case "file_change":
      return item.detail.change.kind === "create" ? "Created file" : item.detail.change.kind === "delete" ? "Deleted file" : "Edited file";
    case "web_search":
      return "Searched web";
    case "browser_action":
      return "Browsed";
    default:
      return itemLabel(item);
  }
}

/** The salient argument, collapsed and clipped. Never the whole payload. */
function preview(item: JournalItem): string {
  const raw = item.detail.type === "command_execution" ? item.detail.command.command
    : item.detail.type === "file_read" ? item.detail.read.path
    : item.detail.type === "file_change" ? item.detail.change.path
    : item.detail.type === "web_search" ? item.detail.query
    : itemLabel(item);
  const flat = raw.replace(/\s+/g, " ").trim();
  return [...flat].length <= 80 ? flat : `${[...flat].slice(0, 80).join("")}…`;
}

const failed = (item: JournalItem) => item.status === "failed";
const running = (item: JournalItem) => item.status === "inProgress";

/** Liveness is a travelling highlight, never a spinner. A spinner per row turns
 *  a busy turn into a slot machine; this stays calm while it works. */
function Shimmer({ text }: { text: string }) {
  return <span className="vnext-shimmer" style={{ ["--spread" as string]: `${text.length * 2}px` }}>
    <span aria-hidden="true" className="vnext-shimmer__sweep">{text}</span>
    {text}
  </span>;
}

function DiffBody({ diff }: { diff: string }) {
  return <pre className="vnext-diff">
    {diff.split("\n").map((line, index) => {
      // `---`/`+++` are the file header, not a removed and an added line.
      // Tested first or every diff opens with one of each.
      const tone = line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@") ? "meta"
        : line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : undefined;
      return <span key={index} className="vnext-diff__line" data-tone={tone}>{line || " "}</span>;
    })}
  </pre>;
}

function ToolRow({ item }: { item: JournalItem }) {
  const [open, setOpen] = useState(false);
  const change = item.detail.type === "file_change" ? item.detail.change : undefined;
  const output = toolOutput(item);
  const body = change?.unifiedDiff ?? output;
  const label = actionLabel(item);

  return <div className="vnext-step" data-status={item.status}>
    <button
      type="button"
      className="vnext-step__row"
      disabled={!body}
      aria-expanded={body ? open : undefined}
      onClick={() => setOpen((current) => !current)}
    >
      <Icon name={TOOL_ICON[item.detail.type] ?? "wrench"} className="vnext-step__icon" />
      {running(item)
        ? <Shimmer text={`${label} · ${preview(item)}`} />
        : <>
            <span className="vnext-step__label">{label}</span>
            <code className="vnext-step__preview">{preview(item)}</code>
          </>}
      {change && (change.linesAdded || change.linesRemoved) ? <span className="vnext-diff-stat">
        {change.linesAdded ? <b data-tone="add">+{change.linesAdded}</b> : null}
        {change.linesRemoved ? <b data-tone="remove">−{change.linesRemoved}</b> : null}
      </span> : null}
      {item.status === "declined" && <span className="vnext-step__badge" data-tone="danger">declined</span>}
      {body && <Icon name="chevron" className="vnext-step__chevron" />}
    </button>
    {open && body && <div className="vnext-step__detail">
      {change?.unifiedDiff ? <DiffBody diff={change.unifiedDiff} /> : <pre className="vnext-step__pre">{output}</pre>}
    </div>}
  </div>;
}

/** Extended thinking. Italic, hairline-indented, quiet — never a card. */
function ReasoningRow({ item }: { item: JournalItem }) {
  const [open, setOpen] = useState(false);
  const text = itemText(item);
  if (!text.trim()) return null;
  if (running(item)) {
    return <div className="vnext-thinking">
      <p className="vnext-thinking__head"><Icon name="sparkle" /><Shimmer text="Thinking" /></p>
      <p className="vnext-thinking__body">{text}<i className="vnext-caret" /></p>
    </div>;
  }
  return <div className="vnext-step">
    <button type="button" className="vnext-step__row" aria-expanded={open} onClick={() => setOpen((c) => !c)}>
      <Icon name="sparkle" className="vnext-step__icon" />
      <span className="vnext-step__label vnext-step__label--thought">Thought</span>
      <Icon name="chevron" className="vnext-step__chevron" />
    </button>
    {open && <p className="vnext-thought">{text}</p>}
  </div>;
}

function PlanRow({ item }: { item: JournalItem }) {
  if (item.detail.type !== "plan") return null;
  const steps = item.detail.plan.steps;
  const done = steps.filter((step) => step.status === "completed").length;
  // Never collapsed: a to-do list exists to be glanceable.
  return <div className="vnext-plan-block">
    <p className="vnext-plan-block__head">
      <Icon name="list" /><span>To-dos</span><em>{done}/{steps.length}</em>
    </p>
    <ul className="vnext-plan">
      {steps.map((step, index) => <li key={index} data-status={step.status}>
        <Icon name={step.status === "completed" ? "check" : step.status === "inProgress" ? "spinner" : "circle"} />
        <span>{step.step}</span>
      </li>)}
    </ul>
  </div>;
}

/** A sub-agent, as one chip plus its own indented lane. */
function TaskGroup({ task }: { task: JournalTask }) {
  const live = task.state === "running" || task.state === "pending" || task.state === "waiting";
  const [open, setOpen] = useState(live);
  const label = task.title ?? task.role ?? "Sub-agent";
  return <div className="vnext-step" data-status={task.state === "failed" ? "failed" : undefined}>
    <button type="button" className="vnext-step__row" aria-expanded={open} onClick={() => setOpen((c) => !c)}>
      <Icon name="bot" className="vnext-step__icon" />
      {live ? <Shimmer text={label} /> : <span className="vnext-step__label">{label}</span>}
      <span className="vnext-step__count">{task.items.length} steps</span>
      <Icon name="chevron" className="vnext-step__chevron" />
    </button>
    {open && <div className="vnext-nest">
      {task.items.map((row) => <TranscriptItem key={row.id} item={row} />)}
      {task.resultText && <div className="vnext-agent-result"><AgentMarkdown text={task.resultText} /></div>}
      {task.failure && <p className="vnext-step__error">{task.failure}</p>}
    </div>}
  </div>;
}

export function TranscriptItem({ item }: { item: JournalItem }) {
  if (item.detail.type === "task") return null;
  if (item.detail.type === "plan") return <PlanRow item={item} />;
  if (item.detail.type === "reasoning") return <ReasoningRow item={item} />;
  if (isToolItem(item)) return <ToolRow item={item} />;
  if (item.detail.type === "error") return <p className="vnext-step__error" role="alert">{item.detail.error.message}</p>;
  if (item.detail.type === "assistant_message") {
    return <AgentMarkdown text={itemText(item)} streaming={running(item)} />;
  }
  // Forward compatibility: an unrecognised row is still a row. A silently
  // missing one is worse than an unstyled one.
  return <p className="vnext-muted vnext-small">{itemLabel(item)}</p>;
}

/** `Ran command ×12 · Read file ×2`, in first-appearance order. */
function tally(items: JournalItem[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const label = item.detail.type === "reasoning" ? "Thought" : actionLabel(item);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => (count > 1 ? `${label} ×${count}` : label)).join(" · ");
}

/**
 * A run of activity rows.
 *
 * While the turn is LIVE this shows only the last step behind a `+N earlier
 * steps` toggle; once settled it collapses behind a tally. Both are the same
 * sentence at two scales, so the grammar is learned once.
 */
/**
 * Rows that will actually paint.
 *
 * A reasoning block the provider opened and never filled renders nothing, and
 * counting it produced the visible lie "6 steps" above five rows. The tally and
 * the list must be derived from the SAME set.
 */
function renderable(items: JournalItem[]): JournalItem[] {
  return items.filter((item) => (item.detail.type === "reasoning" ? itemText(item).trim().length > 0 : true));
}

export function ActivityGroup({ items, live, tasks }: { items: JournalItem[]; live: boolean; tasks: JournalTask[] }) {
  const anyFailed = useMemo(() => items.some(failed) || tasks.some((task) => task.state === "failed"), [items, tasks]);
  const [open, setOpen] = useState(false);
  const rows = renderable(items);
  if (rows.length === 0 && tasks.length === 0) return null;

  // Sub-agents are never hidden by the window: a fan-out is the most
  // interesting thing on the screen while it happens.
  const agents = tasks.map((task) => <TaskGroup key={task.id} task={task} />);

  if (live) {
    const hidden = Math.max(0, rows.length - 1);
    const shown = open ? rows : rows.slice(-1);
    return <div className="vnext-activity">
      {hidden > 0 && <button type="button" className="vnext-activity__toggle" data-tone={!open && anyFailed ? "danger" : undefined} onClick={() => setOpen((c) => !c)}>
        <Icon name="chevron" className="vnext-step__chevron" data-open={open ? "true" : undefined} />
        {!open && anyFailed && <Icon name="alert" className="vnext-step__icon" />}
        {open ? "Show fewer steps" : `+${hidden} earlier steps`}
      </button>}
      {shown.map((item) => <TranscriptItem key={item.id} item={item} />)}
      {agents}
    </div>;
  }

  return <div className="vnext-activity">
    <button type="button" className="vnext-activity__toggle" data-tone={!open && anyFailed ? "danger" : undefined} aria-expanded={open} onClick={() => setOpen((c) => !c)}>
      <Icon name="chevron" className="vnext-step__chevron" data-open={open ? "true" : undefined} />
      {!open && anyFailed && <Icon name="alert" className="vnext-step__icon" />}
      <span className="vnext-activity__count">{rows.length} steps</span>
      <span className="vnext-activity__tally">{tally(rows)}</span>
    </button>
    {open && <div className="vnext-nest">{rows.map((item) => <TranscriptItem key={item.id} item={item} />)}</div>}
    {agents}
  </div>;
}

/**
 * A system event: dashed mono pill between two hairlines.
 *
 * The only mono-uppercase register in the transcript, and the terse machine
 * voice is the point — it makes a system event read as RECORD rather than as
 * the app talking to you.
 */
export function Marker({ text, tone }: { text: string; tone?: "attention" }) {
  return <div className="vnext-marker">
    <i /><span data-tone={tone}>{tone === "attention" && <Icon name="alert" />}{text}</span><i />
  </div>;
}

/** The tail of a live turn: dot, verb, elapsed. No border, no card. */
export function WorkingIndicator({ label, startedAt, now }: { label: string; startedAt?: number; now: number }) {
  const elapsed = startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;
  const stalled = elapsed >= 20;
  const clock = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${String(elapsed % 60).padStart(2, "0")}s` : `${elapsed}s`;
  return <p className="vnext-working" data-stalled={stalled ? "true" : undefined}>
    <i className="vnext-working__dot" />
    <Shimmer text={label} />
    <span className="vnext-working__clock">{clock}</span>
    {/* A run that has said nothing for 20s is the case a detached session
        most needs surfaced — it is the difference between slow and stuck. */}
    {stalled && <span className="vnext-working__stall">· no output {clock}</span>}
  </p>;
}

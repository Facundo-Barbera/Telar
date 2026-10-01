import type { CohortMember, NotificationDetail, NotificationEntry, WakeKind } from "@telar/engine-client";
import { agentNotice, type AgentNoticeInput, inlineExcerpt } from "./agent-notice";
import { firstLine } from "./turn-summary";

const SUMMARY_CHARS = 240;

const BODY_CHARS = 8_000;

const QUOTE_FLOOR = 160;

export const MAX_COHORT_ENTRIES = 50;

export const MAX_DELIVERIES = 2;

const summaryOf = (body: string) => firstLine(body, SUMMARY_CHARS);

function kindOf(wake: WakeKind): "wake" | "request" {
  return wake === "request_opened" ? "request" : "wake";
}

export function peerNotification(input: AgentNoticeInput): NotificationDetail {
  const body = agentNotice(input);
  return {
    kind: "peer_message",
    ...(input.sender?.sessionId ? { sessionId: input.sender.sessionId } : {}),
    runId: input.runId,
    intent: input.intent,
    summary: summaryOf(body),
    fetch: { sessionId: input.recipientSessionId, runId: input.runId },
    body,
  };
}

export function wakeNotification(input: {
  wakeKind: WakeKind;
  targetSessionId: string;
  runId: string;
  requestId?: string;
  body: string;
}): NotificationDetail {
  return {
    kind: kindOf(input.wakeKind),
    sessionId: input.targetSessionId,
    runId: input.runId,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    wakeKind: input.wakeKind,
    summary: summaryOf(input.body),
    fetch: { sessionId: input.targetSessionId, runId: input.runId },
    body: input.body,
  };
}

function asEntry(detail: NotificationDetail): NotificationEntry {
  return {
    kind: detail.kind,
    ...(detail.sessionId ? { sessionId: detail.sessionId } : {}),
    ...(detail.runId ? { runId: detail.runId } : {}),
    ...(detail.requestId ? { requestId: detail.requestId } : {}),
    ...(detail.wakeKind ? { wakeKind: detail.wakeKind } : {}),
    ...(detail.intent ? { intent: detail.intent } : {}),
    summary: detail.summary,
  };
}

export function mergeNotifications(cohort: NotificationDetail[]): NotificationDetail {
  const newest = cohort[cohort.length - 1]!;
  if (cohort.length === 1) return newest;
  const flat = cohort.flatMap((detail) => detail.entries ?? [asEntry(detail)]);
  const entries = flat.filter((entry, index) => !flat.slice(index + 1).some((later) => sameHappening(later, entry))).slice(-MAX_COHORT_ENTRIES);
  if (entries.length === 1) return newest;
  return withCohort(listed(entries, newest), cohort);
}

function withCohort(merged: NotificationDetail, cohort: NotificationDetail[]): NotificationDetail {
  const closes = cohort.filter((detail) => detail.cohortId && detail.cohortOpenedAt !== undefined);
  if (closes.length === 0) return merged;
  return { ...merged, cohortId: closes.at(-1)!.cohortId!, cohortOpenedAt: Math.min(...closes.map((detail) => detail.cohortOpenedAt!)) };
}

function listed(entries: NotificationEntry[], newest: NotificationDetail): NotificationDetail {
  const body = [
    `[engine notification · ${entries.length} ${entries.length === 1 ? "thing" : "things"} happened while this session was working]`,
    "—",
    ...entries.map((entry, index) => `${index + 1}. ${entry.summary}`),
    "—",
    `Each line above names a session and a run. Read whichever matters with sessions_read(sessionId, runId) — the most recent is ${newest.fetch.sessionId} / ${newest.fetch.runId}. None of this was typed by a person.`,
  ].join("\n");
  return {
    ...newest,
    summary: entries.length === 1 ? newest.summary : `${newest.summary.replace(/ \(and \d+ more\)$/, "")} (and ${entries.length - 1} more)`,
    body,
    entries,
  };
}

export function withoutWakesFrom(detail: NotificationDetail, sessionId: string, recipientSessionId: string): NotificationDetail | undefined {
  const all = detail.entries ?? [asEntry(detail)];
  const kept = all.filter((entry) => entry.kind === "peer_message" || entry.sessionId !== sessionId);
  if (kept.length === all.length) return detail;
  if (kept.length === 0) return undefined;
  const newest = kept[kept.length - 1]!;
  const leadIsKept = detail.kind === "peer_message" || detail.sessionId !== sessionId;
  const lead: NotificationDetail = leadIsKept
    ? detail
    : {
        ...newest,
        fetch: { sessionId: newest.kind === "peer_message" ? recipientSessionId : newest.sessionId!, runId: newest.runId! },
        body: "",
      };
  return listed(kept, lead);
}

function sameHappening(a: NotificationEntry, b: NotificationEntry): boolean {
  return a.kind === b.kind && a.sessionId === b.sessionId && a.runId === b.runId;
}

export function mergeRunOutcome(lead: NotificationDetail, ended: NotificationDetail): NotificationDetail {
  const entries = [...(lead.entries ?? [asEntry(lead)]), asEntry(ended)].slice(-MAX_COHORT_ENTRIES);
  return {
    ...lead,
    summary: `${lead.summary.replace(/ \(and \d+ more\)$/, "")} (and ${entries.length - 1} more)`,
    body: [
      lead.body,
      "—",
      `[and since] ${ended.summary}`,
      "That is TWO things about one run, in one notice: the message above, and the fact that the run it came from has since ended. Nothing was withheld and nothing else arrived.",
    ].join("\n"),
    entries,
  };
}

export function heldDelivery(detail: NotificationDetail): NotificationDetail {
  if (detail.kind !== "peer_message" || detail.entries) return detail;
  return {
    ...detail,
    body: `${detail.body}\nIt arrived while this session was working and was held until now; nothing else is waiting.`,
  };
}

export function notificationLabel(detail: NotificationDetail): string {
  const what = detail.kind === "request" ? "request" : detail.kind === "peer_message" ? "peer message" : "wake";
  const where = detail.sessionId ? ` · session ${detail.sessionId}` : "";
  const which = detail.wakeKind ? ` · ${detail.wakeKind}` : "";
  return `[notification: ${what}${which}${where}]`;
}

function wakeKindOf(member: CohortMember): WakeKind {
  if (member.outcome === "failed") return "turn_failed";
  if (member.outcome === "result" || member.outcome === "completed") return "turn_completed";
  return "turn_stopped";
}

const OUTCOME_PHRASE: Record<NonNullable<CohortMember["outcome"]>, string> = {
  result: "result",
  completed: "completed",
  failed: "FAILED",
  stopped: "stopped",
  settled: "settled before it reported",
  archived: "archived before it reported",
  deleted: "deleted before it reported",
};

function memberLine(member: CohortMember, said: boolean): string {
  const who = `${member.sessionId}${member.title ? ` "${member.title}"` : ""}`;
  const ended = member.outcome ? OUTCOME_PHRASE[member.outcome] : `STILL PENDING${member.blocked ? " (its blocker is unanswered)" : " (no result sent)"}`;
  const state = member.spent ? `${ended} (${member.spent})` : ended;
  const text = said && member.firstLine ? `: ${member.firstLine}` : "";
  const read = member.fetch ? ` · sessions_read(sessionId: "${member.fetch.sessionId}", runId: "${member.fetch.runId}")` : "";
  return `${who} — ${state}${text}${read}`;
}

const cutLabel = (more: number) => `It begins (${more.toLocaleString("en-US")} more chars not shown; the read above has them):`;

function quoteOf(member: CohortMember, room: number): string[] | undefined {
  if (!member.excerpt || member.excerpt === member.firstLine) return undefined;
  const whole = member.chars ?? member.excerpt.length;
  const textRoom = room - cutLabel(whole).length - "\n<<<\n\n>>>\n".length - 1;
  if (textRoom < QUOTE_FLOOR) return undefined;
  const { shown, omitted } = inlineExcerpt(member.excerpt, textRoom);
  const more = Math.max(0, whole - member.excerpt.length) + omitted;
  return [more > 0 ? cutLabel(more) : "In full:", "<<<", shown, ">>>"];
}

const sizeOf = (lines: readonly string[]) => lines.reduce((sum, line) => sum + line.length + 1, 0);

function memberSection(members: readonly CohortMember[], room: number): string {
  const numbered = (index: number, line: string) => `${index + 1}. ${line}`;
  const plain = members.map((member, index) => numbered(index, memberLine(member, true)));
  const lines = sizeOf(plain) <= room ? plain : members.map((member, index) => numbered(index, memberLine(member, false)));
  let left = room - sizeOf(lines);
  const quotable = members.map((_, index) => index).filter((index) => members[index]!.excerpt).sort((a, b) => members[a]!.excerpt!.length - members[b]!.excerpt!.length);
  const quotes = new Map<number, { line: string; quote: string[] }>();
  for (const [order, index] of quotable.entries()) {
    const line = numbered(index, memberLine(members[index]!, false));
    const saved = sizeOf([lines[index]!]) - sizeOf([line]);
    const quote = quoteOf(members[index]!, Math.floor(left / (quotable.length - order)) + saved);
    if (!quote) continue;
    quotes.set(index, { line, quote });
    left -= sizeOf(quote) - saved;
  }
  const section = lines.flatMap((line, index) => (quotes.has(index) ? [quotes.get(index)!.line, ...quotes.get(index)!.quote] : [line])).join("\n");
  return section.length <= room ? section : `${section.slice(0, room - 1)}…`;
}

export function cohortNotification(input: {
  cohortId: string;
  openedAt: number;
  members: CohortMember[];
  reason: "all" | "expired";
  minutes: number;
  fallbackFetch: { sessionId: string; runId: string };
}): NotificationDetail {
  const finished = input.members.filter((member) => member.outcome);
  const lead = [...finished].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).at(-1) ?? input.members[0]!;
  const header = input.reason === "all"
    ? `[cohort done · all ${input.members.length} sessions finished]`
    : `[cohort expired · ${finished.length} of ${input.members.length} sessions finished in ${input.minutes} min]`;
  const lines = input.members.map((member) => memberLine(member, true));
  const footer = `Each session: how it ended and what it said, quoted whole where it fits; the call on a line reads the rest.${
    input.reason === "expired" ? " Nothing more will arrive from this cohort — subscribe again with the pending ones to keep waiting." : ""
  } None of this was typed by a person.`;
  const room = BODY_CHARS - header.length - footer.length - "\n—\n\n—\n".length;
  const body = [header, "—", memberSection(input.members, room), "—", footer].join("\n");
  const kind = wakeKindOf(lead);
  return {
    kind: "wake",
    sessionId: lead.sessionId,
    ...(lead.fetch?.sessionId === lead.sessionId ? { runId: lead.fetch.runId } : {}),
    wakeKind: kind,
    summary: summaryOf(header),
    fetch: lead.fetch ?? input.fallbackFetch,
    body,
    entries: input.members.map((member, index) => ({
      kind: member.outcome === "result" ? "peer_message" : "wake",
      sessionId: member.sessionId,
      ...(member.fetch ? { runId: member.fetch.runId } : {}),
      ...(member.outcome === "result" ? { intent: "result" as const } : member.outcome ? { wakeKind: wakeKindOf(member) } : {}),
      summary: summaryOf(lines[index]!),
    })),
    cohortId: input.cohortId,
    cohortOpenedAt: input.openedAt,
  };
}

import type { Turn } from "@telar/engine-client";

function senderPhrase(sender: { sessionId?: string } | undefined): string {
  return sender?.sessionId ? `session ${sender.sessionId}` : "an agent outside any session (the sessions socket)";
}

function verbPhrase(intent: NonNullable<Turn["agentIntent"]>): string {
  switch (intent) {
    case "task":
      return "ASSIGNED this session work";
    case "blocker":
      return "reports a BLOCKER needing this session's intervention";
    case "result":
      return "sent this session a result";
    default:
      return "sent this session a report";
  }
}

export type AgentNoticeInput = {
  recipientSessionId: string;
  runId: string;
  body: string;
  intent: NonNullable<Turn["agentIntent"]>;
  sender?: { sessionId?: string };
  scope?: string;
  corrects?: string;
};

export const INLINE_CHARS = 1_500;

export function inlineExcerpt(text: string, limit = INLINE_CHARS): { shown: string; omitted: number } {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return { shown: trimmed, omitted: 0 };
  const cut = trimmed.slice(0, limit);
  const space = cut.search(/\s\S*$/);
  const shown = (space > limit - 200 ? cut.slice(0, space) : cut).trimEnd();
  return { shown: `${shown}…`, omitted: trimmed.length - shown.length };
}

export function quotedExcerpt(text: string, where: string): string[] {
  const { shown, omitted } = inlineExcerpt(text);
  return [
    omitted > 0 ? `It begins (${omitted.toLocaleString("en-US")} more chars not shown):` : "In full:",
    "<<<",
    shown,
    ">>>",
    omitted > 0 ? `Read the rest with ${where}.` : `The same text is at ${where}.`,
  ];
}

const NO_REPLY = "No reply is needed to acknowledge it.";

export function reportBack(senderSessionId: string): string {
  return `When it is done: sessions_send intent "result" to ${senderSessionId} (the point first, under ~800 chars), then end your turn with one short line. Need a decision: intent "blocker". No progress reports.`;
}

export function agentNotice(input: AgentNoticeInput): string {
  const who = senderPhrase(input.sender);
  const size = `${input.body.length.toLocaleString("en-US")} chars`;
  const where = `sessions_read(sessionId: "${input.recipientSessionId}", runId: "${input.runId}")`;
  const header = `[agent message · ${input.intent}] ${who} ${verbPhrase(input.intent)} (run ${input.runId}, ${size}).${input.corrects ? ` It CORRECTS their earlier message (run ${input.corrects}); disregard that one.` : ""}`;
  if ((input.intent === "result" || input.intent === "blocker") && input.body.trim()) {
    return [header, ...quotedExcerpt(input.body, where), ...(input.intent === "result" ? [NO_REPLY] : [])].join("\n");
  }
  return [
    header,
    input.intent === "task" || input.intent === "blocker"
      ? `None of it is in this notice. Read it with ${where} before acting on it.`
      : `None of it is in this notice. Fetch it with ${where} if it is worth the context.`,
    ...(input.intent === "task" && input.sender?.sessionId ? [reportBack(input.sender.sessionId)] : []),
  ].join("\n");
}

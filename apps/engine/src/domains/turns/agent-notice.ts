import { defaultInstanceIdForDriver, type Session, type TokenUsage, type Turn } from "@telar/engine-client";

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
  spent?: string;
};

export type RunSpend = { model?: string; effort?: string; tokens?: TokenUsage };

const count = (value: number): string =>
  value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${Math.round(value / 1_000)}k` : String(value);

/** The model a run ran on, as the claim resolves it: the turn's pick, else the session's, else the Claude default. */
export function runSpendOf(
  session: Session,
  turn: Pick<Turn, "model"> | undefined,
  known: { tokens?: TokenUsage; defaultModel: (instanceId: string) => string | undefined },
): RunSpend {
  const selection = turn?.model ?? session.model;
  const model = selection?.model ?? (session.driver === "claude" ? known.defaultModel(session.providerInstanceId ?? defaultInstanceIdForDriver("claude")) : undefined);
  return { ...(model ? { model } : {}), ...(selection?.effort ? { effort: selection.effort } : {}), ...(known.tokens ? { tokens: known.tokens } : {}) };
}

export function spendPhrase(spend: RunSpend | undefined): string | undefined {
  if (!spend) return undefined;
  const on = spend.model ? `${spend.model}${spend.effort ? ` at ${spend.effort} effort` : ""}` : undefined;
  const tokens = spend.tokens;
  const total = tokens ? tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate : 0;
  const used = tokens && total > 0
    ? `${count(total)} tokens (${count(tokens.cacheRead)} cache read, ${count(tokens.cacheCreate)} cache write, ${count(tokens.input)} in, ${count(tokens.output)} out)`
    : undefined;
  return on && used ? `${on}, ${used}` : (on ?? used);
}

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
    const spent = input.intent === "result" && input.spent ? [`Its run so far: ${input.spent}.`] : [];
    return [header, ...quotedExcerpt(input.body, where), ...spent, ...(input.intent === "result" ? [NO_REPLY] : [])].join("\n");
  }
  return [
    header,
    input.intent === "task" || input.intent === "blocker"
      ? `None of it is in this notice. Read it with ${where} before acting on it.`
      : `None of it is in this notice. Fetch it with ${where} if it is worth the context.`,
    ...(input.intent === "task" && input.sender?.sessionId ? [reportBack(input.sender.sessionId)] : []),
  ].join("\n");
}

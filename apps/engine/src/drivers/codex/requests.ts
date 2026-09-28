import type { RequestDecision, UserInputField } from "@telar/engine-client";
import { TELAR_BROWSER_MCP_SERVER } from "@telar/engine-client";
import { normalizeOutcome, type DriverRequest, type DriverRequestOutcome, type DriverRun } from "../../provider-contract";
import type { CodexAppServer, CodexServerRequest } from "./app-server";
import { codexApprovalRequest, MCP_ELICITATION, record, str } from "./items";

const LEGACY_APPROVAL_METHODS = new Set(["execCommandApproval", "applyPatchApproval"]);
const REQUEST_USER_INPUT = "item/tool/requestUserInput";

type Gate = DriverRun["onRequest"];

const accepted = (decision: RequestDecision): boolean => decision === "accept" || decision === "acceptForSession";

async function ask(onRequest: NonNullable<Gate>, request: DriverRequest): Promise<DriverRequestOutcome> {
  try {
    return normalizeOutcome(await onRequest(request));
  } catch {
    // A failed gate declines: the app-server has no deadline on an unanswered request.
    return { decision: "decline" };
  }
}

// The wrong vocabulary is silently ignored: `decision` accept/decline for item/*, approved/denied
// for the legacy pair, and MCP's own `action` for an elicitation.
function approvalAnswer(method: string, yes: boolean): Record<string, unknown> {
  if (method === MCP_ELICITATION) return { action: yes ? "accept" : "decline", ...(yes ? { content: {} } : {}) };
  if (LEGACY_APPROVAL_METHODS.has(method)) return { decision: yes ? "approved" : "denied" };
  return { decision: yes ? "accept" : "decline" };
}

function userInputFields(params: Record<string, unknown>): UserInputField[] {
  const questions = Array.isArray(params.questions) ? params.questions.map(record) : [];
  return questions.flatMap((question): UserInputField[] => {
    const id = str(question.id);
    const text = str(question.question);
    if (!id || !text) return [];
    const choices = Array.isArray(question.options)
      ? question.options.map(record).flatMap((option) => (str(option.label) ? [str(option.label)!] : []))
      : [];
    const kind = question.isSecret === true ? ("secret" as const) : choices.length > 0 ? ("choice" as const) : ("text" as const);
    return [{ key: id, label: text, kind, ...(choices.length > 0 ? { choices } : {}), required: true }];
  });
}

// Codex questions are single-select, so an array answer keeps its first pick unless the field says `multiple`.
function userInputAnswers(fields: UserInputField[], outcome: DriverRequestOutcome): Record<string, { answers: string[] }> {
  const answers: Record<string, { answers: string[] }> = {};
  if (!accepted(outcome.decision) || !outcome.answers) return answers;
  for (const field of fields) {
    const value = outcome.answers[field.key];
    if (value === undefined) continue;
    const picks = !Array.isArray(value) ? [String(value)] : field.multiple ? value.map(String) : value.slice(0, 1).map(String);
    if (picks.length > 0) answers[field.key] = { answers: picks };
  }
  return answers;
}

/** Routes every server→client request; answers run detached so the stdout reader never waits on a person. */
export function answerCodexRequests(client: CodexAppServer, onRequest: Gate, onCancel: () => void): void {
  const answerApproval = async (request: CodexServerRequest): Promise<void> => {
    const approval = codexApprovalRequest(request.method, request.params);
    if (!approval || !onRequest) return;
    const { decision } = await ask(onRequest, approval);
    client.respond(request.id, approvalAnswer(request.method, accepted(decision)));
    if (decision === "cancel") onCancel();
  };

  const answerUserInput = async (request: CodexServerRequest): Promise<void> => {
    const fields = userInputFields(request.params);
    const itemId = str(request.params.itemId);
    const outcome: DriverRequestOutcome =
      fields.length > 0 && onRequest
        ? await ask(onRequest, {
            kind: "user_input",
            detail: { kind: "user_input", prompt: "The agent needs your input to continue.", fields },
            toolUseId: itemId ?? `codex_request_${String(request.id)}`,
          })
        : { decision: "decline" };
    client.respond(request.id, { answers: userInputAnswers(fields, outcome) });
    if (outcome.decision === "cancel") onCancel();
  };

  client.onServerRequest = (request) => {
    // The browser socket's own gate already asked the engine; a -32601 here would read as a refused tool.
    if (request.method === MCP_ELICITATION && str(request.params.serverName) === TELAR_BROWSER_MCP_SERVER) {
      client.respond(request.id, { action: "accept", content: {} });
      return true;
    }
    if (request.method === REQUEST_USER_INPUT) {
      void answerUserInput(request);
      return true;
    }
    if (onRequest && codexApprovalRequest(request.method, request.params)) {
      void answerApproval(request);
      return true;
    }
    if (request.method === MCP_ELICITATION) {
      client.respond(request.id, { action: "decline" });
      return true;
    }
    return false;
  };
}

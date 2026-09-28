import { z } from "zod";
import { Id, ProviderRefs, RuntimeMode, Timestamp } from "./common";
import { CommandExecutionDetail, FileChangeDetail, FileReadDetail, ToolCallDetail } from "./items";

export const RequestKind = z.enum([
  "command_execution",
  "file_change",
  "file_read",
  "tool_call",
  /** The agent is asking a question, not asking permission. Never auto-resolved
   *  in any mode — an invented answer is worse than a parked session. */
  "user_input",
  "secret_access",
]);
export type RequestKind = z.infer<typeof RequestKind>;

export const RequestDecision = z.enum([
  "accept",
  /** Accept, and stop asking for this kind of thing for the rest of the
   *  session. The session's effective posture widens; the engine records it. */
  "acceptForSession",
  "decline",
  /** Withdraw the whole turn rather than answering. */
  "cancel",
]);
export type RequestDecision = z.infer<typeof RequestDecision>;

export const RequestResolver = z.enum(["human", "policy", "timeout", "cancelled", "session"]);
export type RequestResolver = z.infer<typeof RequestResolver>;

export const RequestDefault = z.object({
  decision: z.enum(["accept", "decline"]),
  /** For a `user_input` default: the same per-field shape a human's answer has,
   *  as `UserInputField` states it. */
  answers: z.record(z.string(), z.unknown()).optional(),
});
export type RequestDefault = z.infer<typeof RequestDefault>;

export function defaultAllowed(kind: RequestKind): boolean {
  return kind !== "secret_access";
}

export const UserInputField = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["text", "secret", "choice", "boolean"]),
  choices: z.array(z.string()).optional(),
  /** Pick several of `choices`, not one. Only meaningful on `kind: "choice"`;
   *  see the answer-shape rule above, which is the whole point of the flag. */
  multiple: z.boolean().optional(),
  required: z.boolean().optional(),
});
export type UserInputField = z.infer<typeof UserInputField>;

export const SecretCandidate = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  vault: z.string().optional(),
  /** The registrable domain that matched the tab's origin — shown so the human
   *  verifies the same binding the engine enforced. */
  domain: z.string().min(1),
});
export type SecretCandidate = z.infer<typeof SecretCandidate>;

/** Which parts of an item a `secret_access` request wants to fill. `field`
 *  names a specific 1Password field by its label. */
export const SecretFieldKind = z.enum(["username", "password", "otp", "field"]);
export type SecretFieldKind = z.infer<typeof SecretFieldKind>;

export const RememberedLogin = z.object({
  id: z.string().min(1),
  profileId: z.string().min(1),
  profileLabel: z.string().optional(),
  /** The exact origin, scheme included. A grant for one says nothing about
   *  another host of the same registrable domain. */
  origin: z.string().min(1),
  itemId: z.string().min(1),
  itemTitle: z.string().min(1),
  vault: z.string().optional(),
  fields: z.array(z.object({ kind: SecretFieldKind, label: z.string().optional() })).min(1),
  createdAt: z.number(),
  lastUsedAt: z.number().optional(),
});
export type RememberedLogin = z.infer<typeof RememberedLogin>;

/**
 * What a `secret_access` request shows the human: where the fill lands, which
 * kinds of values are wanted, and which items qualify. The human's pick comes
 * back as `answers.item` (a candidate `id`).
 */
export const SecretAccessDetail = z.object({
  /** The tab origin the fill is bound to, e.g. `https://github.com`. Read by
   *  the engine from its own tab state, never from model input. */
  origin: z.string().min(1),
  fields: z.array(z.object({ kind: SecretFieldKind, label: z.string().optional() })).min(1),
  /** Domain-matched items only. Never empty — zero matches refuse the call
   *  before a request is opened. */
  candidates: z.array(SecretCandidate).min(1),
  hint: z.string().optional(),
  profile: z.object({ id: z.string().min(1), label: z.string().optional(), account: z.string().optional() }).optional(),
});
export type SecretAccessDetail = z.infer<typeof SecretAccessDetail>;

/**
 * What exactly is being asked for, per kind. Discriminated so a client
 * rendering an approval card gets the fields that kind has and no others —
 * a command approval needs the command text, a file change needs the diff.
 */
export const RequestDetail = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("command_execution"), command: CommandExecutionDetail }),
  z.object({ kind: z.literal("file_change"), change: FileChangeDetail }),
  z.object({ kind: z.literal("file_read"), read: FileReadDetail }),
  z.object({ kind: z.literal("tool_call"), call: ToolCallDetail }),
  z.object({ kind: z.literal("user_input"), prompt: z.string(), fields: z.array(UserInputField) }),
  z.object({ kind: z.literal("secret_access"), secret: SecretAccessDetail }),
]);
export type RequestDetail = z.infer<typeof RequestDetail>;

export const RequestState = z.enum(["open", "resolved"]);
export type RequestState = z.infer<typeof RequestState>;

export const EngineRequest = z.object({
  id: Id,
  runId: Id,
  sessionId: Id,
  /** The timeline row this request is about, when there is one. */
  itemId: Id.optional(),
  state: RequestState,
  detail: RequestDetail,
  openedAt: Timestamp,

  notified: z.boolean().optional(),

  deadlineMs: z.number().int().positive().optional(),

  default: RequestDefault.optional(),

  decision: RequestDecision.optional(),
  resolvedBy: RequestResolver.optional(),
  resolvedAt: Timestamp.optional(),
  /** Free text a human may attach when declining — fed back to the agent so it
   *  can adapt rather than simply retrying the same thing. */
  reason: z.string().optional(),

  answers: z.record(z.string(), z.unknown()).optional(),

  providerRefs: ProviderRefs.optional(),
});
export type EngineRequest = z.infer<typeof EngineRequest>;

export function autoResolution(mode: RuntimeMode, kind: RequestKind): RequestDecision | null {
  if (kind === "user_input" || kind === "secret_access") return null;
  switch (mode) {
    case "full-access":
      return "accept";
    case "auto":
      return "accept";
    case "auto-accept-edits":
      return kind === "file_change" || kind === "file_read" ? "accept" : null;
    case "approval-required":
      return kind === "file_read" ? "accept" : null;
  }
}

/** True when this mode/kind pair will park and therefore needs someone told.
 *  The inverse of `autoResolution`, named so call sites read as intent. */
export function requiresHuman(mode: RuntimeMode, kind: RequestKind): boolean {
  return autoResolution(mode, kind) === null;
}

export function deadlineResolution(
  request: Pick<EngineRequest, "state" | "openedAt" | "deadlineMs" | "default">,
  now: number,
): RequestDefault | null {
  if (request.state !== "open") return null;
  if (request.deadlineMs === undefined) return null;
  if (request.default === undefined) return null;
  return now - request.openedAt >= request.deadlineMs ? request.default : null;
}

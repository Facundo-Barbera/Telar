/**
 * engine protocol v2 — requests: the things that need a human.
 *
 * A request is opened by the engine when a turn wants to do something its
 * session's `RuntimeMode` does not already permit, and it stays open until
 * something resolves it. While one is open the runtime is `waiting` and NO
 * FURTHER WORK HAPPENS on that session.
 *
 * THIS IS THE FILE THAT DECIDES WHETHER DETACHED RUNS ARE REAL. A session left
 * running overnight that opens an approval at minute three and sits there until
 * morning is not autonomous; it is stuck, and worse, it is stuck silently. Two
 * rules follow from that and both are contract, not implementation detail:
 *
 *   1. `RuntimeMode` determines which requests are auto-resolved and which
 *      genuinely park — see `autoResolution()` below, which is the single
 *      definition of that policy.
 *   2. A request that parks with nobody watching MUST produce a notification.
 *      `RequestOpened.notified` records whether one went out, so "it was stuck
 *      and nobody was told" is a detectable state rather than a guess.
 *
 * v1 had none of this: the driver ran at `permissionMode: "default"` with no
 * `canUseTool` callback, so nothing could be asked in the first place.
 */
import { z } from "zod";
import { Id, ProviderRefs, RuntimeMode, Timestamp } from "./common";
import { CommandExecutionDetail, FileChangeDetail, FileReadDetail, ToolCallDetail } from "./items";

/**
 * What is being asked.
 *
 * KINDS ARE COARSE ON PURPOSE. The temptation is one kind per tool; the reason
 * not to is that a human's answer is about capability, not vocabulary — "may
 * you run shell commands here" is one decision whether the tool is called Bash
 * or exec_command. Provider-specific naming stays in `providerRefs`.
 */
export const RequestKind = z.enum([
  "command_execution",
  "file_change",
  "file_read",
  "tool_call",
  /** The agent is asking a question, not asking permission. Never auto-resolved
   *  in any mode — an invented answer is worse than a parked session. */
  "user_input",
  /** The agent wants a credential filled from the user's password manager.
   *  Never auto-resolved in any mode, `full-access` included: a secret leaving
   *  the vault is the one capability no runtime mode may hand out on its own.
   *  The human's answer also PICKS the item (`answers.item`), so policy has
   *  nothing it could even resolve with. */
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

/** Who answered. `policy` means no human was involved — the runtime mode
 *  resolved it — and that distinction is what makes an audit trail honest.
 *  `session` means ANOTHER SESSION answered, through `sessions_resolve_request`:
 *  an agent, not a person, and the trail must say so for the same reason. */
export const RequestResolver = z.enum(["human", "policy", "timeout", "cancelled", "session"]);
export type RequestResolver = z.infer<typeof RequestResolver>;

/** One field the agent wants filled in. Only present on `user_input`. */
export const UserInputField = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["text", "secret", "choice", "boolean"]),
  choices: z.array(z.string()).optional(),
  required: z.boolean().optional(),
});
export type UserInputField = z.infer<typeof UserInputField>;

/**
 * One password-manager item a `secret_access` request may fill from.
 *
 * METADATA ONLY, BY CONSTRUCTION. This shape crosses the journal, the cockpit,
 * and the phone, so it may never grow a field that could carry a value: id,
 * title, vault and matched domain are what 1Password itself shows on a locked
 * list. The values stay behind the resolver until the human has accepted.
 */
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

/**
 * ONE REMEMBERED LOGIN, as the cockpit lists it.
 *
 * METADATA ONLY, for the same reason `SecretCandidate` is: this shape crosses
 * the settings page and the phone. It names WHICH item, in which vault, for
 * which browser profile and origin, and which kinds of field were approved —
 * never a value, and never a way to read one.
 */
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
  /** The agent's item hint, surfaced so the human sees what was asked for. */
  hint: z.string().optional(),
  /**
   * WHICH BROWSER IDENTITY this fill lands in — the named profile the session's
   * browser is running under. Shown because a person with several accounts is
   * deciding about ONE of them, and it is what a remembered authorization is
   * scoped to. Metadata only, like everything else on this shape. Absent when
   * the host has no named profiles (an older desktop shell), which is also when
   * `remember` is not offered.
   */
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

/**
 * NAMED `EngineRequest`, NOT `Request`, and that is not stylistic. `Request` is
 * a DOM global (the fetch API's), so in any browser-facing file a bare
 * `Request` type annotation resolves to THAT with no error — TypeScript simply
 * uses the wrong type and the code compiles. Measured: `session-cockpit.tsx`
 * typechecked against the fetch `Request` and only failed later, on unrelated
 * property accesses, with a message that pointed nowhere near the cause. The
 * `Engine` prefix matches `EngineEvent` and `EngineHealth`.
 */
export const EngineRequest = z.object({
  id: Id,
  runId: Id,
  sessionId: Id,
  /** The timeline row this request is about, when there is one. */
  itemId: Id.optional(),
  state: RequestState,
  detail: RequestDetail,
  openedAt: Timestamp,

  /** Whether a notification was dispatched when this parked. Absent means the
   *  request never parked (it resolved immediately by policy). */
  notified: z.boolean().optional(),

  decision: RequestDecision.optional(),
  resolvedBy: RequestResolver.optional(),
  resolvedAt: Timestamp.optional(),
  /** Free text a human may attach when declining — fed back to the agent so it
   *  can adapt rather than simply retrying the same thing. */
  reason: z.string().optional(),

  /**
   * Answers to a `user_input` request, keyed by `UserInputField.key` — and the
   * item pick of a `secret_access` request, under the key `item`.
   *
   * `remember: true` on a `secret_access` answer is the human ticking the
   * card's opt-in box: it authorizes LATER fills of the same item, in the same
   * browser profile, on the same origin, for the same field kinds — and
   * nothing else. Absent and false are the same thing, which is why the box is
   * unchecked by default and no mode can supply it.
   */
  answers: z.record(z.string(), z.unknown()).optional(),

  providerRefs: ProviderRefs.optional(),
});
export type EngineRequest = z.infer<typeof EngineRequest>;

/**
 * THE AUTO-RESOLUTION POLICY, defined once.
 *
 * Returns the decision a runtime mode makes on its own, or `null` when the
 * request genuinely parks and needs a human. It lives in the CONTRACT rather
 * than in the engine because two independent parties must agree on it: the
 * engine, which enforces it, and every client, which has to tell the user what
 * a mode will do BEFORE they pick it. A settings screen that describes this
 * from memory is a settings screen that lies after the first policy change.
 *
 * The shape of the ladder:
 *   approval-required  asks about everything except reads
 *   auto-accept-edits  edits and reads pass; commands and tools still ask
 *   auto               everything inside the session's boundary passes;
 *                      `user_input` still parks, because it is a question
 *   full-access        nothing asks
 *
 * `user_input` NEVER auto-resolves. It is the one kind where the engine has no
 * defensible answer to invent, in any mode. `secret_access` shares the rule for
 * a different reason: a mode may widen what the AGENT can do, never what the
 * VAULT gives up — and the resolution carries the human's item pick, which no
 * policy could invent either.
 */
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

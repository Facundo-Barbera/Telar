// THE HARNESS PORT — one event vocabulary, one tool shape, two harnesses.
//
// WHY THIS EXISTS. Telar drives two agent harnesses that agree on nothing at
// the wire: the Claude Agent SDK is an in-process `query()` yielding SDK
// message objects, and Codex is a `codex app-server` subprocess speaking
// newline-delimited JSON-RPC over stdio. Everything above the harness — the
// conversation shell, the permission card, the loom lifecycle — must not care
// which of those produced a given turn. This module is where "must not care"
// stops being an aspiration and becomes a type.
//
// WHAT WENT WRONG WITHOUT IT. The vocabulary below is not invented here; it was
// already being spoken, twice, in two places, under a provider's name
// (`CodexNormalizedEvent` in apps/web/lib/codex-app-server.ts, and the Claude
// branch of api/chat/route.ts emitting the same shapes by hand). Two dialects
// of one language, with no compiler checking they stayed the same language.
// What that cost, concretely: Codex published no `mcp-servers` capability, so
// a user asking a Codex session to run an Ultra got no ultra tool, no error,
// and a model that narrated spawning three agents it had not spawned. A
// capability the port can state is a capability a surface can check.
//
// WHAT IT DELIBERATELY IS NOT. Not a reimplementation of either harness — the
// research this follows (t3code, 2026-07-31) is explicit that the winning move
// is to wrap and normalize, never to reimplement, and to pass provider-specific
// knobs through as opaque option values rather than modelling them here. So the
// port carries the events every harness genuinely produces and stops. A knob
// only Codex has (`personality`, `permissions` profiles) or only Claude has
// (`settingSources`) belongs in that provider's own option schema, not in this
// file, and a `HarnessEvent` variant that only one harness can ever emit is a
// design smell rather than a feature.
//
// CORE OWNS THE SCHEMAS because they describe a persisted, replayed stream —
// the same rule that puts every other persisted-entity schema in this package.
// Nothing here imports a harness SDK, a fetch, or a filesystem: it is types and
// zod, so both adapters and every test can hold it without dragging a
// subprocess or a client bundle along.
import { z } from "zod";
import type { ProviderId } from "./schemas";
import type { ProviderCapability } from "./providers";

// ── the canonical event stream ─────────────────────────────────────────────
//
// One turn is an ordered sequence of these. THREADS: `threadId` is present and
// non-root ONLY for events belonging to a subagent's own thread; a root-thread
// event omits it. That asymmetry is load-bearing and predates this file — it is
// what lets a surface that knows nothing about subagents render the common case
// unchanged, and it is why the field is optional rather than always-present.

const Usage = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_input_tokens: z.number(),
  cache_creation_input_tokens: z.number(),
});
export type Usage = z.infer<typeof Usage>;

// A single rate-limit window as the harness reported it, RAW. The port relays;
// it does not shape. Mapping a window onto a five-hour/seven-day PlanSnapshot is
// a surface concern and differs per provider, so doing it here would bake one
// provider's window vocabulary into the neutral layer.
const RateWindow = z
  .object({
    usedPercent: z.number(),
    windowDurationMins: z.number().nullable(),
    resetsAt: z.number().nullable(),
  })
  .nullable();

export const HarnessEvent = z.discriminatedUnion("type", [
  // The harness accepted the turn and named its thread. Exactly once, first.
  z.object({ type: z.literal("session"), sessionId: z.string() }),

  // Reasoning. `thinking_start` opens a block; deltas fill it. A harness that
  // opens a block and never sends a delta is not a protocol error — Codex does
  // exactly that — which is why the surface must treat an empty block as
  // nothing to draw rather than as a moment that will pass.
  z.object({ type: z.literal("thinking_start"), itemId: z.string(), threadId: z.string().optional() }),
  z.object({
    type: z.literal("thinking_delta"),
    itemId: z.string(),
    text: z.string(),
    threadId: z.string().optional(),
  }),

  // Assistant prose. `text_delta` streams; `text` is the settled whole. Both
  // exist because the two harnesses stream differently — the SDK sends only
  // deltas, the app-server also re-sends the full text-so-far on completion —
  // and collapsing them would force one adapter to fabricate the other's shape.
  z.object({
    type: z.literal("text_delta"),
    itemId: z.string(),
    text: z.string(),
    threadId: z.string().optional(),
  }),
  z.object({ type: z.literal("text"), itemId: z.string(), text: z.string(), threadId: z.string().optional() }),

  // Tool execution, harness-agnostic: the same pair covers a built-in Bash, an
  // MCP tool on the Claude side, and a dynamic tool on the Codex side.
  z.object({
    type: z.literal("tool"),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
    threadId: z.string().optional(),
  }),
  z.object({
    type: z.literal("tool_result"),
    id: z.string(),
    output: z.string(),
    isError: z.boolean(),
    threadId: z.string().optional(),
  }),

  z.object({ type: z.literal("usage"), usage: Usage }),
  z.object({ type: z.literal("error"), message: z.string(), threadId: z.string().optional() }),

  z.object({
    type: z.literal("rate_limits"),
    primary: RateWindow,
    secondary: RateWindow,
    planType: z.string().nullable(),
  }),

  // A subagent was spawned, and later finished. `parentThreadId` is RAW — a
  // subagent spawning a sub-subagent reports its own id here, not the root's.
  // Flattening that nesting is the surface's job (both branches already have a
  // flattener); doing it in the adapter would destroy information the surface
  // needs to attribute cost.
  z.object({
    type: z.literal("spawn"),
    parentThreadId: z.string(),
    childThreadId: z.string(),
    prompt: z.string(),
    model: z.string().nullable(),
  }),
  z.object({
    type: z.literal("spawn_result"),
    childThreadId: z.string(),
    output: z.string(),
    isError: z.boolean(),
  }),
]);
export type HarnessEvent = z.infer<typeof HarnessEvent>;

/** Every `type` the union can take, so a conformance test can enumerate the
 *  whole vocabulary rather than the subset one adapter happens to emit today.
 *  Same idiom as PROVIDER_CAPABILITIES in providers.ts, and for the same
 *  reason: a behavioural test alone passes on a union that silently lost a
 *  member. */
export const HARNESS_EVENT_TYPES = HarnessEvent.options.map(
  (o) => o.shape.type.value,
) as readonly HarnessEvent["type"][];

// ── transport-neutral tools ────────────────────────────────────────────────
//
// THE ONE DEFINITION, TWO REGISTRATIONS problem. Telar's own tools (ultra,
// loom, workspace) are written once and must reach both harnesses:
//
//   · Claude takes them in-process via the Agent SDK's createSdkMcpServer +
//     tool(name, description, zodShape, handler).
//   · Codex takes them as `dynamicTools` on thread/start — {name, description,
//     inputSchema} as JSON Schema — and then sends a `dynamicToolCall` REQUEST
//     back over the same stdio channel, which the adapter answers in-process.
//
// Those are the same idea with different spellings, so the tool is defined once
// as a descriptor and each adapter registers it in its own dialect. This is why
// the descriptor carries a ZOD SHAPE rather than JSON Schema: zod is the richer
// source, the Claude path needs it natively, and zod v4 converts to JSON Schema
// for Codex (z.toJSONSchema) — the reverse direction would be lossy.
//
// NO SDK IMPORT HERE. The descriptor is a plain object so this module stays
// harness-free; the adapters own the conversion. That also keeps the tool
// definitions testable without either harness present.

/** What a tool hands back. Deliberately WIDER than the text-only case Telar's
 *  tools actually return, because this type has to be a supertype of the Agent
 *  SDK's own CallToolResult for the structural compatibility below to hold. */
export type HarnessToolResult = {
  content: Array<{ type: string; [k: string]: unknown }>;
  isError?: boolean;
};

/** THE FIELD NAMES HERE ARE NOT ARBITRARY. This type is structurally identical
 *  to the Agent SDK's `SdkMcpToolDefinition` — same `name`, `description`,
 *  `inputSchema` (a zod RAW SHAPE, `{script: z.string()}`, not a z.object), and
 *  `handler`. That is the whole trick: the SDK's `tool()` helper already
 *  RETURNS a value of this shape, so Telar's existing tool definitions become
 *  harness-neutral descriptors by being exported, with no rewriting of a single
 *  handler. Renaming a field here would silently break that and force a
 *  translation layer for no gain. */
export type HarnessToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  /** `extra` is accepted-and-ignored so an SDK-built tool assigns cleanly; a
   *  handler that takes only `args` is assignable to this, which is why the
   *  Codex adapter can call either. */
  handler: (args: never, extra?: never) => Promise<HarnessToolResult>;
};

/** A named group of tools. Both harnesses namespace: Claude surfaces these as
 *  `mcp__<namespace>__<tool>`, Codex as a DynamicToolNamespaceSpec. Keeping the
 *  namespace in the descriptor set — rather than baking it into each tool name
 *  — is what lets one definition produce both spellings. */
export type HarnessToolNamespace = {
  name: string;
  version: string;
  tools: readonly HarnessToolDescriptor[];
};

// ── the port ───────────────────────────────────────────────────────────────

/** Provider-specific knobs, passed through OPAQUELY. The research is explicit
 *  that this is the boundary that keeps an adapter layer from rotting into a
 *  reimplementation: a trait one harness has and the other does not (Codex's
 *  `personality`, Claude's `settingSources`) rides here as an option value and
 *  never becomes a field on the neutral request. */
export type HarnessOptions = Record<string, unknown>;

export type HarnessTurnRequest = {
  prompt: string;
  cwd: string;
  model: string;
  /** Resolved by accountEnv(profile) — adapters never resolve credentials
   *  themselves, which is what keeps "Telar stores no provider credentials"
   *  true on every harness. */
  env: Record<string, string | undefined>;
  /** Resume cursor for this thread on THIS provider. A model-only change keeps
   *  the cursor; switching provider must start fresh, because a cursor is only
   *  meaningful to the harness that issued it. */
  resume?: string | null;
  /** Appended to the system prompt where the harness supports it. Claude:
   *  systemPrompt.append. Codex: developerInstructions on thread/start. A
   *  harness that supports neither must FAIL the turn rather than drop this
   *  silently — see the capability gate. */
  instructions?: string;
  tools?: readonly HarnessToolNamespace[];
  signal?: AbortSignal;
  options?: HarnessOptions;
};

/** What every adapter implements. One method, because a turn is the only thing
 *  a harness does; everything else Telar needs (cost, approval, resume) is
 *  either an event on the stream or a field on the request. */
export interface HarnessPort {
  readonly id: ProviderId;
  readonly capabilities: readonly ProviderCapability[];
  runTurn(req: HarnessTurnRequest): AsyncGenerator<HarnessEvent>;
}

/** THE GATE, in one place. A request asking for something the harness does not
 *  publish fails BEFORE the stream opens — AD-11's "no silent degradation,
 *  ever". Returns the unmet capability, or null when the turn may proceed.
 *
 *  This is the check that was missing when a Codex session was asked for an
 *  Ultra: nothing consulted the capability list, so instead of an error the
 *  user got a confident fiction. */
export function unmetRequirement(
  port: Pick<HarnessPort, "capabilities">,
  req: Pick<HarnessTurnRequest, "tools" | "instructions">,
): ProviderCapability | null {
  const has = (c: ProviderCapability) => port.capabilities.includes(c);
  if (req.tools?.length && !has("mcp-servers")) return "mcp-servers";
  if (req.instructions?.trim() && !has("system-prompt-append")) return "system-prompt-append";
  return null;
}

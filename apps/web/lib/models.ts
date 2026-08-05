// Verified against the Claude API model catalog (2026-06). Prices are USD per
// MTok — shown as "API-equivalent" since subscription usage doesn't bill per token.
export type ModelInfo = {
  id: string;
  name: string;
  provider?: "claude" | "codex"; // undefined = claude
  tier: "frontier" | "opus" | "sonnet" | "haiku" | "codex";
  context: string;
  maxOutput: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number; // ~0.1x input
  blurb: string;
  note?: string;
};

// Curated FALLBACK list only. The composer fetches the live catalog from
// GET /api/models?provider=claude|codex (see lib/model-registry.ts) and falls
// back to modelsForProvider() below when the live source is unavailable.
export const MODELS: ModelInfo[] = [
  {
    id: "claude-fable-5",
    name: "Fable 5",
    tier: "frontier",
    context: "1M",
    maxOutput: "128K",
    inputPerMTok: 10,
    outputPerMTok: 50,
    cacheReadPerMTok: 1,
    blurb: "Most capable — demanding reasoning, long-horizon agentic work",
    note: "Thinking always on. Turns can run minutes.",
  },
  {
    id: "claude-opus-4-8",
    name: "Opus 4.8",
    tier: "opus",
    context: "1M",
    maxOutput: "128K",
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    blurb: "Highly autonomous — long-horizon agents, knowledge work, memory",
  },
  {
    id: "claude-sonnet-5",
    name: "Sonnet 5",
    tier: "sonnet",
    context: "1M",
    maxOutput: "128K",
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    blurb: "Near-Opus coding & agentic quality at Sonnet cost — the dev workhorse",
    note: "Intro pricing $2/$10 through 2026-08-31.",
  },
  {
    id: "claude-haiku-4-5",
    name: "Haiku 4.5",
    tier: "haiku",
    context: "200K",
    maxOutput: "64K",
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadPerMTok: 0.1,
    blurb: "Fastest and cheapest — triage, mechanical edits, quick lookups",
  },
  // Codex models (OpenAI). Priced via the ChatGPT subscription, so per-token
  // figures are 0 here — the plan-usage rings track the real limits instead.
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    provider: "codex",
    tier: "codex",
    context: "400K",
    maxOutput: "128K",
    inputPerMTok: 0,
    outputPerMTok: 0,
    cacheReadPerMTok: 0,
    blurb: "Codex flagship — strongest coding & agentic model",
    note: "ChatGPT subscription; no per-token billing.",
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    provider: "codex",
    tier: "codex",
    context: "400K",
    maxOutput: "128K",
    inputPerMTok: 0,
    outputPerMTok: 0,
    cacheReadPerMTok: 0,
    blurb: "Balanced Codex model",
    note: "ChatGPT subscription.",
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 mini",
    provider: "codex",
    tier: "codex",
    context: "400K",
    maxOutput: "128K",
    inputPerMTok: 0,
    outputPerMTok: 0,
    cacheReadPerMTok: 0,
    blurb: "Fast, cheap Codex model",
    note: "ChatGPT subscription.",
  },
];

export const DEFAULT_MODEL = "claude-sonnet-5";
export const DEFAULT_CODEX_MODEL = "gpt-5.5";

// WHICH MODEL A FRESH SESSION OPENS ON, asked of a table instead of of a
// ternary. `provider === "codex" ? DEFAULT_CODEX_MODEL : DEFAULT_MODEL` was
// written out three separate times — the composer's provider switch, the chat
// route's model fallback, and /api/models' advertised default — and three
// copies of one answer is three places for a fourth provider to be forgotten.
//
// A Record over the provider union rather than a lookup by tag: the type
// checker then requires an entry per provider, so adding one is a build error
// here instead of a session that quietly opens on a model belonging to somebody
// else's harness. models.test.ts asserts each id is a real model OF that
// provider, which is the half a Record cannot check.
const DEFAULT_MODEL_BY_PROVIDER: Record<"claude" | "codex", string> = {
  claude: DEFAULT_MODEL,
  codex: DEFAULT_CODEX_MODEL,
};

export const defaultModelFor = (p: "claude" | "codex"): string =>
  DEFAULT_MODEL_BY_PROVIDER[p];

export const modelById = (id: string): ModelInfo | undefined =>
  MODELS.find((m) => m.id === id);

export const modelsForProvider = (p: "claude" | "codex"): ModelInfo[] =>
  MODELS.filter((m) => (m.provider ?? "claude") === p);

// Mirrors the SDK's own EffortLevel union exactly (see @anthropic-ai/claude-agent-sdk's
// `EffortLevel` export) — kept as a local literal type rather than importing it so this
// file (pulled into the client bundle by the composer) never depends on the SDK package.
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export type EffortOption = {
  id: EffortLevel;
  label: string;
  blurb: string;
};

export const EFFORT_OPTIONS: EffortOption[] = [
  {
    id: "low",
    label: "Low",
    blurb: "Minimal thinking, fastest responses.",
  },
  {
    id: "medium",
    label: "Medium",
    blurb: "Moderate thinking for everyday tasks.",
  },
  {
    id: "high",
    label: "High",
    blurb: "Deep reasoning for harder problems.",
  },
  {
    id: "xhigh",
    label: "Extra high",
    blurb: "Deeper than high. Availability is model-dependent — older models may ignore or reject it.",
  },
  {
    id: "max",
    label: "Max",
    blurb: "Maximum reasoning effort. Availability is model-dependent — older models may ignore or reject it.",
  },
];

export const effortById = (id: string): EffortOption | undefined =>
  EFFORT_OPTIONS.find((e) => e.id === id);

// Codex reasoning effort — mirrors the Codex SDK's ModelReasoningEffort union
// ("minimal" instead of Claude's "max").
export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export const CODEX_EFFORT_OPTIONS: { id: CodexReasoningEffort; label: string; blurb: string }[] = [
  { id: "minimal", label: "Minimal", blurb: "Fastest, least reasoning." },
  { id: "low", label: "Low", blurb: "Light reasoning." },
  { id: "medium", label: "Medium", blurb: "Balanced everyday reasoning." },
  { id: "high", label: "High", blurb: "Deep reasoning for harder problems." },
  { id: "xhigh", label: "Extra high", blurb: "Maximum reasoning." },
];

// THE LAST OF THE OLD CODEX ACCESS VOCABULARY, kept alive for exactly one
// release and for exactly one caller: the chat route's legacy-body gate, which
// validates a pre-rename `sandbox` field as strictly as it ever did before
// mapping it forward through runtimeModeFromLegacy. Everything else that used
// to live here — CODEX_APPROVAL_PRESETS, DEFAULT_CODEX_APPROVAL_ID,
// DEFAULT_CODEX_SANDBOX — is deleted: a session's access is one RuntimeMode
// now, and leaving a second table describing the same thing meant the next
// reader had two answers and no compiler signal telling them which was live.
//
// @deprecated Dies with the route's legacy gate. Nothing new may read it.
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

/** @deprecated The route's one-release wire-compatibility gate only. */
export const CODEX_SANDBOX_PRESETS: { id: string; sandbox: CodexSandbox }[] = [
  { id: "read-only", sandbox: "read-only" },
  { id: "auto", sandbox: "workspace-write" },
  { id: "full", sandbox: "danger-full-access" },
];

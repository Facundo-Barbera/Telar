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

// Codex sandbox presets. The Codex SDK (`codex exec`) can't prompt mid-turn, so
// each preset is a STATIC choice made before the turn — approvalPolicy is always
// "never"; an action the sandbox blocks fails back to the model, never to a card.
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

export const CODEX_SANDBOX_PRESETS: {
  id: string;
  label: string;
  blurb: string;
  sandbox: CodexSandbox;
}[] = [
  { id: "read-only", label: "Read-only", blurb: "Analysis only — no edits, no network.", sandbox: "read-only" },
  { id: "auto", label: "Auto", blurb: "Edits + network (gh, npm, git); writes stay in the repo.", sandbox: "workspace-write" },
  { id: "full", label: "Full access", blurb: "Unrestricted edits and network access.", sandbox: "danger-full-access" },
];

export const DEFAULT_CODEX_SANDBOX: CodexSandbox = "workspace-write";

// Codex approval policy — mirrors the app-server's AskForApproval union. The
// app-server can now prompt mid-turn (see lib/codex-app-server.ts), so each
// preset below pairs a sandbox with an approvalPolicy, mirroring the Codex
// desktop app's own approval dropdown.
export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";

export const CODEX_APPROVAL_PRESETS: {
  id: string;
  label: string;
  blurb: string;
  sandbox: CodexSandbox;
  approvalPolicy: CodexApprovalPolicy;
}[] = [
  {
    id: "read-only",
    label: "Read-only",
    blurb: "Analysis only — no edits, no network.",
    sandbox: "read-only",
    approvalPolicy: "never",
  },
  {
    id: "auto",
    label: "Approve for me",
    blurb: "Only asks for actions detected as risky.",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
  },
  {
    id: "ask",
    label: "Ask for approval",
    blurb: "Asks before editing external files or using the network.",
    sandbox: "workspace-write",
    approvalPolicy: "untrusted",
  },
  {
    id: "full",
    label: "Full access",
    blurb: "Unrestricted.",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  },
];

export const DEFAULT_CODEX_APPROVAL_ID = "auto";

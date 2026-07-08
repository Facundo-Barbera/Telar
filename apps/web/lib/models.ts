// Verified against the Claude API model catalog (2026-06). Prices are USD per
// MTok — shown as "API-equivalent" since subscription usage doesn't bill per token.
export type ModelInfo = {
  id: string;
  name: string;
  tier: "frontier" | "opus" | "sonnet" | "haiku";
  context: string;
  maxOutput: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number; // ~0.1x input
  blurb: string;
  note?: string;
};

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
];

export const DEFAULT_MODEL = "claude-sonnet-5";

export const modelById = (id: string): ModelInfo | undefined =>
  MODELS.find((m) => m.id === id);

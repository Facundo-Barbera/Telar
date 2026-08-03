// Provider-neutral persisted shape for a harness's latest context-window
// snapshot. Claude currently supplies every field through Query.getContextUsage;
// other harnesses can populate the same shape when they expose equivalent data.
// Optional drill-downs keep older snapshots and less-capable providers valid.

export type ContextUsageItem = {
  name: string;
  tokens: number;
};

export type ContextUsageSnapshot = {
  source: "claude-sdk" | "codex-app-server";
  categories: Array<ContextUsageItem & { color: string; isDeferred?: boolean }>;
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens: number;
  percentage: number;
  model: string;
  autoCompactThreshold?: number;
  isAutoCompactEnabled: boolean;
  memoryFiles: Array<{ path: string; type: string; tokens: number }>;
  mcpTools: Array<{
    name: string;
    serverName: string;
    tokens: number;
    isLoaded?: boolean;
  }>;
  deferredBuiltinTools?: Array<ContextUsageItem & { isLoaded: boolean }>;
  systemTools?: ContextUsageItem[];
  systemPromptSections?: ContextUsageItem[];
  agents: Array<{ agentType: string; source: string; tokens: number }>;
  slashCommands?: {
    totalCommands: number;
    includedCommands: number;
    tokens: number;
  };
  skills?: {
    totalSkills: number;
    includedSkills: number;
    tokens: number;
    skillFrontmatter: Array<{ name: string; source: string; tokens: number }>;
  };
  messageBreakdown?: {
    toolCallTokens: number;
    toolResultTokens: number;
    attachmentTokens: number;
    assistantMessageTokens: number;
    userMessageTokens: number;
    redirectedContextTokens: number;
    unattributedTokens: number;
    toolCallsByType: Array<{ name: string; callTokens: number; resultTokens: number }>;
    attachmentsByType: ContextUsageItem[];
  };
  // Codex's app-server exposes an exact token-accounting breakdown for the
  // latest model request, but (unlike Claude) does not attribute prompt tokens
  // to system instructions, tools, MCP, skills, or conversation history.
  // Cached/reasoning figures are subsets of input/output respectively and are
  // therefore drill-down rows, not additional top-level context categories.
  requestBreakdown?: {
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
  };
};

export type ContextUsageDisplayCategory = ContextUsageItem & {
  color: string;
  isDeferred?: boolean;
};

// Claude's wire response puts every prompt token not assigned to a system/tool
// category under "Messages". Its own analyzer then exposes the useful split in
// messageBreakdown, including `unattributedTokens`: the remainder between the
// authoritative API input total and transcript records it can count locally.
// Keep that remainder in total occupancy, but never present it as human chat.
export function contextUsageDisplayCategories(
  snapshot: ContextUsageSnapshot,
): ContextUsageDisplayCategory[] {
  const breakdown = snapshot.messageBreakdown;
  if (!breakdown) return snapshot.categories;

  return snapshot.categories.flatMap((category) => {
    if (category.name !== "Messages") return [category];

    const conversationTokens =
      breakdown.userMessageTokens +
      breakdown.assistantMessageTokens +
      breakdown.toolCallTokens +
      breakdown.toolResultTokens;
    const knownTokens =
      conversationTokens +
      breakdown.attachmentTokens +
      breakdown.redirectedContextTokens;
    // Derive this from the category total so the display remains lossless if
    // a future Claude build's reported unattributedTokens drifts by rounding
    // or adds a new message subcategory Telar does not know yet.
    const unattributedTokens = Math.max(0, category.tokens - knownTokens);

    return [
      { name: "Conversation", tokens: conversationTokens, color: "var(--chart-2)" },
      {
        name: "Runtime attachments",
        tokens: breakdown.attachmentTokens,
        color: "var(--chart-5)",
      },
      {
        name: "Redirected context",
        tokens: breakdown.redirectedContextTokens,
        color: "var(--chart-4)",
      },
      {
        name: "Unattributed context",
        tokens: unattributedTokens,
        color: "var(--muted-foreground)",
      },
    ].filter((item) => item.tokens > 0);
  });
}

type ClaudeContextUsage = Omit<ContextUsageSnapshot, "source">;

// Keep the persisted contract deliberately smaller than Claude's wire response
// (which also includes a pre-rendered grid and duplicate API usage totals).
// Those presentation fields are useful to Claude Code itself but would couple
// Telar's store to one UI implementation without adding attribution data.
export function fromClaudeContextUsage(raw: ClaudeContextUsage): ContextUsageSnapshot {
  return {
    source: "claude-sdk",
    categories: raw.categories,
    totalTokens: raw.totalTokens,
    maxTokens: raw.maxTokens,
    rawMaxTokens: raw.rawMaxTokens,
    percentage: raw.percentage,
    model: raw.model,
    autoCompactThreshold: raw.autoCompactThreshold,
    isAutoCompactEnabled: raw.isAutoCompactEnabled,
    memoryFiles: raw.memoryFiles,
    mcpTools: raw.mcpTools,
    deferredBuiltinTools: raw.deferredBuiltinTools,
    systemTools: raw.systemTools,
    systemPromptSections: raw.systemPromptSections,
    agents: raw.agents,
    slashCommands: raw.slashCommands,
    skills: raw.skills,
    messageBreakdown: raw.messageBreakdown,
  };
}

export function fromCodexContextUsage(raw: {
  model: string;
  totalTokens: number;
  modelContextWindow: number | null;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}): ContextUsageSnapshot {
  const totalTokens = Math.max(0, raw.totalTokens);
  const inputTokens = Math.max(0, raw.inputTokens);
  const outputTokens = Math.max(0, raw.outputTokens);
  const attributed = inputTokens + outputTokens;
  const remainder = Math.max(0, totalTokens - attributed);
  const maxTokens = Math.max(0, raw.modelContextWindow ?? 0);
  const freeTokens = Math.max(0, maxTokens - totalTokens);

  return {
    source: "codex-app-server",
    categories: [
      { name: "Input context", tokens: inputTokens, color: "var(--chart-2)" },
      { name: "Model output", tokens: outputTokens, color: "var(--chart-4)" },
      ...(remainder > 0
        ? [{ name: "Accounting remainder", tokens: remainder, color: "var(--muted-foreground)" }]
        : []),
      ...(freeTokens > 0
        ? [{ name: "Free space", tokens: freeTokens, color: "var(--muted)" }]
        : []),
    ],
    totalTokens,
    maxTokens,
    rawMaxTokens: maxTokens,
    percentage: maxTokens > 0 ? (totalTokens / maxTokens) * 100 : 0,
    model: raw.model,
    isAutoCompactEnabled: false,
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    requestBreakdown: {
      inputTokens,
      cachedInputTokens: Math.max(0, raw.cachedInputTokens),
      cacheWriteInputTokens: Math.max(0, raw.cacheWriteInputTokens),
      outputTokens,
      reasoningOutputTokens: Math.max(0, raw.reasoningOutputTokens),
    },
  };
}

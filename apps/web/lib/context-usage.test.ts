// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  contextUsageDisplayCategories,
  fromClaudeContextUsage,
  fromCodexContextUsage,
} from "./context-usage";

describe("Claude context usage projection", () => {
  test("keeps attribution data and drops Claude's presentation-only grid", () => {
    const raw = {
      categories: [{ name: "Messages", tokens: 1200, color: "#abc" }],
      totalTokens: 1200,
      maxTokens: 180_000,
      rawMaxTokens: 200_000,
      percentage: 0.67,
      model: "claude-sonnet",
      isAutoCompactEnabled: true,
      autoCompactThreshold: 180_000,
      memoryFiles: [{ path: "/repo/CLAUDE.md", type: "project", tokens: 80 }],
      mcpTools: [{ name: "search", serverName: "docs", tokens: 45 }],
      agents: [{ agentType: "Explore", source: "built-in", tokens: 30 }],
      gridRows: [[{ categoryName: "Messages" }]],
      apiUsage: { input_tokens: 1 },
    };

    const snapshot = fromClaudeContextUsage(raw);

    expect(snapshot.source).toBe("claude-sdk");
    expect(snapshot.categories[0]).toEqual(raw.categories[0]);
    expect(snapshot.memoryFiles[0]?.path).toBe("/repo/CLAUDE.md");
    expect(snapshot.mcpTools[0]?.serverName).toBe("docs");
    expect(snapshot).not.toHaveProperty("gridRows");
    expect(snapshot).not.toHaveProperty("apiUsage");
  });

  test("separates Claude's unattributed remainder from conversation messages", () => {
    const snapshot = fromClaudeContextUsage({
      categories: [
        { name: "System prompt", tokens: 200, color: "prompt" },
        { name: "Messages", tokens: 1000, color: "messages" },
      ],
      totalTokens: 1200,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      percentage: 1,
      model: "claude-sonnet",
      isAutoCompactEnabled: false,
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      messageBreakdown: {
        toolCallTokens: 50,
        toolResultTokens: 100,
        attachmentTokens: 200,
        assistantMessageTokens: 80,
        userMessageTokens: 70,
        redirectedContextTokens: 20,
        unattributedTokens: 480,
        toolCallsByType: [],
        attachmentsByType: [],
      },
    });

    const categories = contextUsageDisplayCategories(snapshot);
    expect(categories.map(({ name, tokens }) => ({ name, tokens }))).toEqual([
      { name: "System prompt", tokens: 200 },
      { name: "Conversation", tokens: 300 },
      { name: "Runtime attachments", tokens: 200 },
      { name: "Redirected context", tokens: 20 },
      { name: "Unattributed context", tokens: 480 },
    ]);
    expect(categories.reduce((sum, category) => sum + category.tokens, 0)).toBe(1200);
  });
});

describe("Codex context usage projection", () => {
  test("keeps exact context occupancy and request accounting without inventing prompt sections", () => {
    const snapshot = fromCodexContextUsage({
      model: "gpt-5.4",
      totalTokens: 50_252,
      modelContextWindow: 258_400,
      inputTokens: 49_978,
      cachedInputTokens: 49_536,
      cacheWriteInputTokens: 0,
      outputTokens: 274,
      reasoningOutputTokens: 38,
    });

    expect(snapshot.source).toBe("codex-app-server");
    expect(snapshot.totalTokens).toBe(50_252);
    expect(snapshot.maxTokens).toBe(258_400);
    expect(snapshot.categories.map(({ name, tokens }) => ({ name, tokens }))).toEqual([
      { name: "Input context", tokens: 49_978 },
      { name: "Model output", tokens: 274 },
      { name: "Free space", tokens: 208_148 },
    ]);
    expect(snapshot.requestBreakdown).toEqual({
      inputTokens: 49_978,
      cachedInputTokens: 49_536,
      cacheWriteInputTokens: 0,
      outputTokens: 274,
      reasoningOutputTokens: 38,
    });
    expect(snapshot.systemPromptSections).toBeUndefined();
    expect(snapshot.mcpTools).toEqual([]);
  });
});

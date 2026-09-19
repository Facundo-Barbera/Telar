/**
 * THE MODEL — OpenCode Go through `@langchain/openai`, and the key ladder the
 * engine already owns.
 *
 * ── THE KEY IS NOT THIS FILE'S BUSINESS ─────────────────────────────────────
 * `resolveGoCredential` is IMPORTED from `apps/engine/src/main-session/
 * credentials.ts` rather than reimplemented, which is the point: the lab proves
 * compatibility with the resolver that ships, not with a copy of it that agrees
 * today. Nothing here logs, returns or stores the key — `describeGoCredential`
 * says which rung answered and that is the whole diagnostic, exactly as the
 * engine's own rules require.
 *
 * ── THE TWO HEADERS ─────────────────────────────────────────────────────────
 * opencode.ai/docs/go asks a third-party agent to identify itself and to carry
 * a stable per-conversation id. This lab is NOT the engine, so it introduces
 * itself as `telar-agent-lab/<ver>` rather than borrowing `telar/<ver>` — a log
 * on the other side must be able to tell an evaluation apart from the product.
 * `x-opencode-session` is the LangGraph THREAD id, because a thread is what a
 * conversation is here.
 */
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { OPENCODE_GO_BASE, DEFAULT_GO_MODEL } from "../../../../apps/engine/src/main-session/go";
import { describeGoCredential, resolveGoCredential } from "../../../../apps/engine/src/main-session/credentials";
import { RecordedChatModel, type RecordedScript } from "./recorded";

export const LAB_VERSION = "0.1";
export const LAB_USER_AGENT = `telar-agent-lab/${LAB_VERSION}`;

export type ModelChoice =
  | { mode: "recorded"; script: RecordedScript; name?: string }
  | { mode: "live"; threadId: string; model?: string };

/** True when this run is allowed to spend a real call. Every scenario reads
 *  this one flag, so "did that number come from the network" is answerable. */
export function liveSmokeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TELAR_LIVE_SMOKE === "1";
}

/** Which rung the key came from, for the scenario's own log. Never the key. */
export function describeCredential(): string {
  return describeGoCredential(resolveGoCredential({}));
}

/**
 * The live model.
 *
 * THROWS WHEN THERE IS NO KEY rather than falling back to the recorded one: a
 * live smoke that quietly ran offline would put a fabricated call count in the
 * report, which is the one failure this lab cannot afford.
 */
export function goChatModel(input: { threadId: string; model?: string; temperature?: number; streaming?: boolean }): ChatOpenAI {
  const credential = resolveGoCredential({});
  if (!credential) {
    throw new Error(
      "No OpenCode Go key on any rung (Telar setting, OPENCODE_API_KEY, or the OpenCode CLI's auth.json). " +
        "A live smoke needs one; run without TELAR_LIVE_SMOKE=1 for the recorded model.",
    );
  }
  return new ChatOpenAI({
    apiKey: credential.key,
    model: input.model ?? DEFAULT_GO_MODEL,
    temperature: input.temperature ?? 0,
    streaming: input.streaming ?? false,
    streamUsage: true,
    configuration: {
      baseURL: OPENCODE_GO_BASE,
      defaultHeaders: {
        "User-Agent": LAB_USER_AGENT,
        "x-opencode-session": input.threadId,
      },
    },
  });
}

/** One entry point for both modes, so a scenario reads the same either way. */
export function buildModel(choice: ModelChoice): BaseChatModel {
  if (choice.mode === "live") return goChatModel({ threadId: choice.threadId, ...(choice.model ? { model: choice.model } : {}), streaming: true });
  return new RecordedChatModel({ script: choice.script, ...(choice.name ? { name: choice.name } : {}) });
}

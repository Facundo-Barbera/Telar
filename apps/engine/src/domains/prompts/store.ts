import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PreparedPrompt, PREPARED_PROMPT_SCHEMA_VERSION, type PreparedPromptAuthor } from "@telar/engine-client";
import { atomicWrite } from "../../platform/fs/atomic";
import type { EngineStatePaths } from "../../state";

export class PreparedPromptsError extends Error {
  constructor(
    readonly code: "invalid_request" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "PreparedPromptsError";
  }
}

// The id is checked rather than escaped: this is where a caller-supplied string becomes a path.
export function promptsPath(paths: EngineStatePaths, projectId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) {
    throw new PreparedPromptsError("invalid_request", `"${projectId}" is not a project id this shelf can address.`);
  }
  return path.join(paths.root, "prompts", `${projectId}.json`);
}

const newPromptId = (): string => `q-${crypto.randomBytes(6).toString("hex")}`;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const two = (value: number): string => String(value).padStart(2, "0");

function promptLabel(at: Date): string {
  return `${WEEKDAYS[at.getDay()]} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

// Newest first. The id tiebreak only keeps a hand-edited file with equal stamps stable.
export function sortPrompts(prompts: readonly PreparedPrompt[]): PreparedPrompt[] {
  return [...prompts].sort((left, right) => right.created.at - left.created.at || left.id.localeCompare(right.id));
}

export function readPrompts(paths: EngineStatePaths, projectId: string): PreparedPrompt[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(promptsPath(paths, projectId), "utf8"));
  } catch (error) {
    if (error instanceof PreparedPromptsError) throw error;
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const prompts: PreparedPrompt[] = [];
  for (const row of raw) {
    const parsed = PreparedPrompt.safeParse(row);
    if (!parsed.success) continue;
    if (parsed.data.projectId !== projectId) continue;
    if (prompts.some((prompt) => prompt.id === parsed.data.id)) continue;
    prompts.push(parsed.data);
  }
  return sortPrompts(prompts);
}

function writePrompts(paths: EngineStatePaths, projectId: string, prompts: readonly PreparedPrompt[]): PreparedPrompt[] {
  const parsed = sortPrompts(prompts.map((prompt) => PreparedPrompt.parse(prompt)));
  atomicWrite(promptsPath(paths, projectId), parsed);
  return parsed;
}

export function getPrompt(paths: EngineStatePaths, projectId: string, id: string): PreparedPrompt | null {
  return readPrompts(paths, projectId).find((prompt) => prompt.id === id) ?? null;
}

const MAX_TEXT_BYTES = 256 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_REASON_LENGTH = 400;

// At the cap the oldest prompt is dropped rather than the write refused.
export const PROMPT_SHELF_LIMIT = 50;

type NewPreparedPrompt = {
  title: string;
  text: string;
  sessionId?: string;
  reason?: string;
  author: PreparedPromptAuthor;
};

function assertTitle(title: unknown): string {
  if (typeof title !== "string" || !title.trim()) {
    throw new PreparedPromptsError("invalid_request", "A prepared prompt needs a title — a few words naming what it asks for.");
  }
  if (title.trim().length > MAX_TITLE_LENGTH) {
    throw new PreparedPromptsError("invalid_request", `A title is a few words, not ${title.trim().length} characters.`);
  }
  return title.trim();
}

function assertText(text: unknown): string {
  if (typeof text !== "string" || !text.trim()) {
    throw new PreparedPromptsError("invalid_request", "A prepared prompt needs its text — the message that would be sent.");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    throw new PreparedPromptsError("invalid_request", `A prepared prompt holds up to ${MAX_TEXT_BYTES / 1024} KB of text; this one is larger.`);
  }
  return text;
}

function assertReason(reason: unknown): string {
  if (typeof reason !== "string") {
    throw new PreparedPromptsError("invalid_request", "A reason is one line of text saying why this prompt is being offered.");
  }
  if (reason.trim().length > MAX_REASON_LENGTH) {
    throw new PreparedPromptsError("invalid_request", `A reason is one line, not ${reason.trim().length} characters.`);
  }
  return reason.trim();
}

export function createPrompt(paths: EngineStatePaths, projectId: string, input: NewPreparedPrompt, at: Date = new Date()): PreparedPrompt {
  const existing = readPrompts(paths, projectId);
  // Stamps are strictly increasing within a shelf: two creates often land in one millisecond,
  // and the id tiebreak would then order them at random.
  const moment = Math.max(at.getTime(), (existing[0]?.created.at ?? 0) + 1);
  const stamp = { label: promptLabel(new Date(moment)), at: moment };
  const reason = input.reason === undefined ? "" : assertReason(input.reason);
  const prompt = PreparedPrompt.parse({
    id: newPromptId(),
    projectId,
    ...(input.sessionId?.trim() ? { sessionId: input.sessionId.trim() } : {}),
    title: assertTitle(input.title),
    text: assertText(input.text),
    ...(reason ? { reason } : {}),
    created: stamp,
    updated: stamp,
    author: input.author,
    schemaVersion: PREPARED_PROMPT_SCHEMA_VERSION,
  });
  writePrompts(paths, projectId, [prompt, ...existing].slice(0, PROMPT_SHELF_LIMIT));
  return prompt;
}

const PATCHABLE = ["title", "text", "reason"] as const;

type PreparedPromptPatch = Partial<{ title: string; text: string; reason: string }>;

export function updatePrompt(
  paths: EngineStatePaths,
  projectId: string,
  id: string,
  patch: PreparedPromptPatch,
  at: Date = new Date(),
): PreparedPrompt | null {
  const forbidden = Object.keys(patch).filter((key) => !(PATCHABLE as readonly string[]).includes(key));
  if (forbidden.length > 0) {
    throw new PreparedPromptsError(
      "invalid_request",
      `A prepared prompt's ${forbidden.map((key) => `\`${key}\``).join(", ")} cannot be patched. ` +
        "`author` is provenance stamped at creation, and `id`, `projectId` and `created` are identity — " +
        `moving a prompt between projects is writing a new one. Patch only: ${PATCHABLE.join(", ")}.`,
    );
  }
  const prompts = readPrompts(paths, projectId);
  const found = prompts.find((prompt) => prompt.id === id);
  if (!found) return null;
  const { reason: had, ...rest } = found;
  const reason = patch.reason === undefined ? had : assertReason(patch.reason) || undefined;
  const next = PreparedPrompt.parse({
    ...rest,
    ...(reason ? { reason } : {}),
    ...(patch.title !== undefined ? { title: assertTitle(patch.title) } : {}),
    ...(patch.text !== undefined ? { text: assertText(patch.text) } : {}),
    updated: { label: promptLabel(at), at: at.getTime() },
  });
  writePrompts(
    paths,
    projectId,
    prompts.map((prompt) => (prompt.id === id ? next : prompt)),
  );
  return next;
}

export function deletePrompt(paths: EngineStatePaths, projectId: string, id: string): boolean {
  const prompts = readPrompts(paths, projectId);
  if (!prompts.some((prompt) => prompt.id === id)) return false;
  writePrompts(
    paths,
    projectId,
    prompts.filter((prompt) => prompt.id !== id),
  );
  return true;
}

// The project's own prompts plus the ones prepared for this session.
export function promptsForComposer(prompts: readonly PreparedPrompt[], sessionId: string | undefined): PreparedPrompt[] {
  return prompts.filter((prompt) => prompt.sessionId === undefined || prompt.sessionId === sessionId);
}

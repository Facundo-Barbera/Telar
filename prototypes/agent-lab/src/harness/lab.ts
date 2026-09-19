/**
 * ONE WIRING, USED BY EVERY SCENARIO AND BOTH VARIANTS.
 *
 * The comparison the issue asks for is only worth anything if A and B differ in
 * the framework and in NOTHING ELSE — same walls, same fixture, same model,
 * same meter. So the wiring lives here once and a variant is handed the result.
 *
 * Part B (Deep Agents) builds its agent from `lab.tools` and `lab.model` exactly
 * as `src/variants/langgraph.ts` does; it should not need to touch the fixture.
 */
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { sessionsTools } from "../../../../apps/engine/src/sessions-tools/tools";
import { notesTools } from "../../../../apps/engine/src/notes-tools/tools";
import { buildToolWalls } from "./adapter";
import { fixtureNotesCapability, fixtureSessionsCapability } from "./fixtures/capabilities";
import { FixtureEngine, type FixtureEngineOptions } from "./fixtures/engine";
import { Meter } from "./meter";
import { buildModel, type ModelChoice } from "./model";

export type LabOptions = {
  label: string;
  model: ModelChoice;
  engine?: FixtureEngineOptions;
  /** Watches every tool call as it happens — what scenario 6 asserts on. */
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
};

export type Lab = {
  label: string;
  engine: FixtureEngine;
  meter: Meter;
  tools: StructuredToolInterface[];
  model: BaseChatModel;
  close(): void;
};

export function createLab(options: LabOptions): Lab {
  const engine = new FixtureEngine(options.engine ?? {});
  const meter = new Meter(options.label);
  const sessions = fixtureSessionsCapability(engine);
  const notes = fixtureNotesCapability(engine);
  const tools = buildToolWalls(
    [(factory) => sessionsTools(factory, sessions), (factory) => notesTools(factory, notes)],
    { meter, ...(options.onToolCall ? { onCall: options.onToolCall } : {}) },
  );
  const model = buildModel(options.model);
  return {
    label: options.label,
    engine,
    meter,
    tools,
    model,
    close: () => engine.close(),
  };
}

/** Both walls' tool names, in the order a model is shown them. Printed by the
 *  scenarios so the report's "what the Agent can do" list is measured. */
export function toolNames(tools: StructuredToolInterface[]): string[] {
  return tools.map((one) => one.name);
}

import type { AutoCompact, Item, McpServer, NotificationDetail, TaskSeed, TurnAttachment, RequestDecision, RequestDefault, RequestDetail, RequestKind, TurnObservation, UsageSnapshot, UserInputField } from "@telar/engine-client";
import type { SessionsCapability } from "../domains/sessions";
import type { NotesCapability } from "../domains/notes";
import type { PromptsCapability } from "../domains/prompts";
import type { DisplayCapability } from "../domains/agent-tools";
import type { RunCapability } from "../domains/terminal";
import type { SteerMailbox } from "../domains/turns";

export type { SessionsCapability };

export type DriverRequest = {
  kind: RequestKind;
  detail: RequestDetail;
  toolUseId: string;
  deadlineMs?: number;
  default?: RequestDefault;
  signal?: AbortSignal;
};

export type DriverRequestOutcome = { decision: RequestDecision; answers?: Record<string, unknown> };

export function normalizeOutcome(value: RequestDecision | DriverRequestOutcome): DriverRequestOutcome {
  return typeof value === "string" ? { decision: value } : value;
}

export type DriverRun = {
  runId?: string;
  prompt: string;
  promptFromHuman?: boolean;
  notification?: NotificationDetail;
  sessionId: string;
  cwd?: string;
  signal: AbortSignal;
  steer?: SteerMailbox;
  sessions?: SessionsCapability;
  notes?: NotesCapability;
  prompts?: PromptsCapability;
  run?: RunCapability;
  plugins?: Record<string, unknown>;
  display?: DisplayCapability;
  model?: string;
  effort?: string;
  fastMode?: boolean;
  serviceTier?: string;
  ultracode?: boolean;
  orientation?: string;
  mainBriefing?: string;
  attachments?: TurnAttachment[];
  mcpServers?: McpServer[];
  env?: Record<string, string | undefined>;
  binaryPath?: string;
  autoCompact?: AutoCompact;
  providerInstanceId?: string;
  browserSocket?: { url: string; token: string };
  telarSocketLease?: { url: string; token: string; generation: string };
  transcript?(options?: { turns?: number }): Promise<Item[]>;
  providerSessionId?: string;
  tasks?: TaskSeed[];
  session?: DriverSessionHooks;
  onObservations(observations: TurnObservation[]): Promise<void>;
  onRequest?(request: DriverRequest): Promise<RequestDecision | DriverRequestOutcome>;
};

export type DriverResult = {
  text: string;
  providerSessionId?: string;
  usage?: UsageSnapshot;
};

export type ProviderTurnBinding = {
  runId: string;
  onObservations(observations: TurnObservation[]): Promise<void>;
  onRequest?(request: DriverRequest): Promise<RequestDecision | DriverRequestOutcome>;
  close(result: DriverResult | { failure: string }): Promise<void>;
  wanted?: AbortSignal;
};

export type DriverSessionHooks = {
  onTasks(observations: TurnObservation[]): Promise<void>;
  onProviderTurn(input: {
    input: string;
    reason: { kind: "task_notification" | "background_task" | "unknown"; taskId?: string };
  }): Promise<ProviderTurnBinding | undefined>;
};

export type TurnDriver = {
  run(input: DriverRun): Promise<DriverResult>;
  dispose?(): void;
  stopTask?(sessionId: string, providerTaskId: string): Promise<boolean>;
};

export function questionChoices(question: Record<string, unknown>): { choices: string[] } & Pick<UserInputField, "header" | "descriptions"> {
  const options = Array.isArray(question.options) ? question.options : [];
  const choices: string[] = [];
  const descriptions: Record<string, string> = {};
  for (const option of options) {
    if (typeof option !== "object" || option === null) continue;
    const { label, description } = option as Record<string, unknown>;
    if (typeof label !== "string" || !label) continue;
    choices.push(label);
    if (typeof description === "string" && description) descriptions[label] = description;
  }
  const header = typeof question.header === "string" && question.header ? question.header : undefined;
  return {
    choices,
    ...(header ? { header } : {}),
    ...(Object.keys(descriptions).length > 0 ? { descriptions } : {}),
  };
}

export function requireCwd(cwd: string | undefined, provider: string): string {
  if (cwd === undefined) {
    throw new Error(`${provider} runs inside a working directory, and this session has none. Sessions with no checkout run on Telar's own driver.`);
  }
  return cwd;
}

export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}


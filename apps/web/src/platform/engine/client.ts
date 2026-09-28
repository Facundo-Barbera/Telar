import type {
InboxPolicy,SidebarLayout,Project,LiveSessionRow,Turn,
TurnSubmissionResult,SessionAssignment
} from "@telar/engine-client";
import { pathnameFetcher } from "@/platform/engine/host-client";
import { domainMethods } from "@telar/engine-client";
import { apiTransport, EngineApiError, type Fetcher } from "./transport";
import { machineCalls, settingsCalls } from "./machine-calls";
import { sessionCalls, turnCalls } from "./session-calls";
import { integrationCalls, workspaceCalls } from "./workspace-calls";
export { asEngineError, EngineApiError, refusedBy, READ_BUDGET, OPEN_BUDGET } from "./transport";

/** One pass of the rail. `unchanged` means keep what you have, so `sessions` cannot be read without checking it. */
export type LiveSessionsPage = {
  sessions: LiveSessionRow[];
  projects: Project[];
  assignments?: Record<string, SessionAssignment[]>;
  layout?: SidebarLayout;
  /** Which engine answered — what folds two reads that reached ONE Mac.
   *  Absent from an engine too old to stamp it; the rail then leaves its
   *  hosts undeduplicated rather than dropping rows. */
  daemonId?: string;
  /** The settling window these rows band by, this engine's own. Absent
   *  from an older engine; the rail falls back to its default. */
  inbox?: InboxPolicy;
  /** What to pass as `since` next time. Absent from an engine too old to
   *  count, which keeps every read a full one. */
  revision?: number;
  /** How many SETTLED rows this answer left out (#457) — the size of the shelf
   *  behind `?all=1`. Absent from an engine that predates the filter, which
   *  means "you have everything", never "the shelf is empty". */
  settledCount?: number;
  /** Open terminals per session in this answer, whoever opened them (#883).
   *  Absent from an older engine, which reads as "none known". */
  terminals?: Record<string, number>;
  unchanged?: false;
};

/** The default fetcher follows the address bar to a host's proxy; pass `hostFetcher(id)` to pin one Mac. */
export function createEngineApi(fetcher: Fetcher = pathnameFetcher) {
  return {
    ...domainMethods(apiTransport(fetcher)),
    ...machineCalls(fetcher),
    ...settingsCalls(fetcher),
    ...sessionCalls(fetcher),
    ...turnCalls(fetcher),
    ...workspaceCalls(fetcher),
    ...integrationCalls(fetcher),
  };
}

// `crypto.randomUUID` is missing off a secure context (plain HTTP to a non-loopback host).
// Not Math.random: this id is the idempotency key a retried submission is matched on.
function randomUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 1
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Browser-generated ids are stable if the submission has to be retried. */
export function newRunId(uuid: () => string = randomUuid): string {
  return `run_${uuid().replaceAll("-", "")}`;
}

type TurnApi = Pick<ReturnType<typeof createEngineApi>, "discardAmbiguousTurn" | "submitTurn">;

/** Abandons the lost run's execution and keeps everything else; nothing is resubmitted. */
export async function continueAfterAmbiguousTurn(
  api: Pick<ReturnType<typeof createEngineApi>, "discardAmbiguousTurn">,
  sessionId: string,
  turn: Pick<Turn, "runId" | "state">,
): Promise<void> {
  if (turn.state !== "ambiguous") {
    throw new EngineApiError("conflict", "Only an ambiguous turn needs a recovery decision.");
  }
  await api.discardAmbiguousTurn(sessionId, turn.runId);
}

/** Records the discard, then submits the same prompt under a new id. Work the first attempt did is not undone. */
export async function retryAmbiguousTurn(
  api: TurnApi,
  sessionId: string,
  turn: Pick<Turn, "runId" | "state" | "input">,
  createRunId: () => string = newRunId,
): Promise<TurnSubmissionResult> {
  if (turn.state !== "ambiguous") {
    throw new EngineApiError("conflict", "Only an ambiguous turn requires explicit discard before retrying.");
  }
  await api.discardAmbiguousTurn(sessionId, turn.runId);
  const runId = createRunId();
  if (runId === turn.runId) {
    throw new EngineApiError("conflict", "Retry must use a fresh run id.");
  }
  return api.submitTurn(sessionId, { runId, input: turn.input });
}

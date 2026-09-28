import type {
InboxPolicy,SidebarLayout,Project,LiveSessionRow,
SessionAssignment
} from "@telar/engine-client";
import { pathnameFetcher, type Fetcher } from "@/platform/engine/host-client";
import { domainMethods } from "@telar/engine-client";
import { apiTransport } from "./transport";
import { randomUuid } from "@/platform/random-uuid";
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

/** Browser-generated ids are stable if the submission has to be retried. */
export function newRunId(uuid: () => string = randomUuid): string {
  return `run_${uuid().replaceAll("-", "")}`;
}


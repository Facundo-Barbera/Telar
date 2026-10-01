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
  /** Which engine answered, to fold two reads that reached one Mac; absent from an older engine. */
  daemonId?: string;
  /** The settling window these rows band by; absent from an older engine. */
  inbox?: InboxPolicy;
  /** What to pass as `since` next time. */
  revision?: number;
  /** How many settled rows the default answer left out; absent means it left none out. */
  settledCount?: number;
  /** Open terminals per session in this answer, whoever opened them. */
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


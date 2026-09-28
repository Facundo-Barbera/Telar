import type { Subscription } from "@telar/engine-client";
import type { Kernel } from "../../platform/kernel";
import { SessionActivity } from "./activity";
import { SessionAttachments } from "./attachment-store";
import { OpenPrefixes, SessionItems } from "./items";
import { SessionMailbox } from "./mailbox";
import { SessionQueues } from "./queue";
import { SessionRecords } from "./records";
import { SessionRequests } from "./requests";
import { SessionIndex } from "./session-index";
import { SessionQueries } from "./queries";
import { SessionTasks } from "./tasks";

/** What the sessions modules still ask of the store around them. */
type SessionHost = {
  subscriptionsOf: (sessionId: string) => readonly Subscription[];
  nextWake: (sessionId: string) => number | undefined;
  autoSettleAfterHours: () => number | null;
  onQueueChanged?: () => void;
};

/** Builds the sessions store modules on one kernel and wires them to each other. */
export function createSessionModules(kernel: Kernel, host: SessionHost) {
  const records: SessionRecords = new SessionRecords(kernel, {
    withActivity: (session) => activity.of(session),
    readQueue: (sessionId) => queues.read(sessionId),
  });
  const items = new SessionItems(kernel);
  const requests = new SessionRequests(kernel, () => records.ids());
  const tasks = new SessionTasks(kernel);
  const mailbox = new SessionMailbox(kernel);
  const activity: SessionActivity = new SessionActivity(kernel, {
    readQueue: (sessionId) => queues.read(sessionId),
    liveRequests: (sessionId) => requests.live(sessionId),
    peekRun: (sessionId, runId) => items.peekRun(sessionId, runId),
    readTasks: (sessionId) => tasks.read(sessionId),
    require: (sessionId) => records.require(sessionId),
    subscriptionsOf: host.subscriptionsOf,
    nextWake: host.nextWake,
  });
  const index = new SessionIndex(kernel, {
    withActivityFrom: (session, turns) => activity.from(session, turns),
    readQueue: (sessionId) => queues.read(sessionId),
    autoSettleAfterHours: host.autoSettleAfterHours,
  });
  const queues: SessionQueues = new SessionQueues(kernel, {
    sessionIds: () => records.ids(),
    itemsForRuns: (sessionId, runs) => items.forRuns(sessionId, runs),
    afterWrite: (sessionId, turns) => requests.trim(sessionId, turns),
    ...(host.onQueueChanged ? { onChanged: host.onQueueChanged } : {}),
  });
  const prefixes = new OpenPrefixes(kernel, (sessionId) => queries.readEvents(sessionId));
  const attachments = new SessionAttachments(kernel, (sessionId) => void records.require(sessionId));
  const queries: SessionQueries = new SessionQueries(kernel, {
    records, items, tasks, requests,
    readQueue: (sessionId) => queues.read(sessionId),
    autoSettleAfterHours: host.autoSettleAfterHours,
  });
  return { records, items, requests, tasks, mailbox, activity, index, queues, prefixes, attachments, queries };
}

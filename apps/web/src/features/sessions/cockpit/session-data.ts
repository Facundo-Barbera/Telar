import type { SetStateAction } from "react";
import type { EngineEvent, EngineRequest, Item, Session, SnapshotPage, Task, Turn } from "@telar/engine-client";
import { mergeRows } from "@/platform/engine";

export type SessionData = {
  session?: Session;
  turns: Turn[];
  items: Item[];
  tasks: Task[];
  requests: EngineRequest[];
  events: EngineEvent[];
  page?: SnapshotPage;
  readKey?: string;
};

type Rows = Pick<SessionData, "turns" | "items" | "tasks">;

export type SessionDataAction =
  | { type: "replace"; data: Omit<SessionData, "readKey">; readKey?: string }
  | { type: "tail"; data: Rows & Pick<SessionData, "session" | "requests" | "events"> }
  | { type: "older"; data: Rows & Pick<SessionData, "page"> }
  | { type: "session"; next: SetStateAction<Session | undefined> }
  | { type: "clear" }
  | { type: "landed"; readKey: string };

export const emptySessionData: SessionData = { turns: [], items: [], tasks: [], requests: [], events: [] };

export function sessionDataReducer(state: SessionData, action: SessionDataAction): SessionData {
  switch (action.type) {
    case "replace": {
      const { session, turns, items, tasks, requests, events, page } = action.data;
      return { session, turns, items, tasks, requests, events, page, readKey: action.readKey ?? state.readKey };
    }
    case "tail":
      return {
        ...state,
        session: action.data.session,
        events: action.data.events,
        turns: mergeRows(state.turns, action.data.turns, (turn) => turn.runId),
        items: mergeRows(state.items, action.data.items, (item) => item.id),
        tasks: mergeRows(state.tasks, action.data.tasks, (task) => task.id),
        requests: action.data.requests,
      };
    case "older":
      return {
        ...state,
        turns: mergeRows(action.data.turns, state.turns, (turn) => turn.runId),
        items: mergeRows(action.data.items, state.items, (item) => item.id),
        tasks: mergeRows(action.data.tasks, state.tasks, (task) => task.id),
        page: action.data.page,
      };
    case "session": {
      const session = typeof action.next === "function" ? action.next(state.session) : action.next;
      return session === state.session ? state : { ...state, session };
    }
    case "clear":
      return { ...state, turns: [], items: [], tasks: [], requests: [], events: [] };
    case "landed":
      return state.readKey === action.readKey ? state : { ...state, readKey: action.readKey };
  }
}

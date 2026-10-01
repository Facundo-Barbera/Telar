import path from "node:path";
import { RELEASABLE_STATES, type ReleasableState } from "@telar/engine-client";
import { onRotationalDisk } from "../../platform/fs/volumes";
import { HttpError } from "../../platform/http/http";
import { ok, type Route } from "../../platform/http/route";
import type { EngineStore } from "../../state";
import { describeReclaim } from "./inventory";
import { clearWorktreesRoot, defaultWorktreesRoot, probeWorktreesRoot, rootOf, worktreesRootBlocker, writeWorktreesRoot } from "./location";
import { describeOutcome } from "./move";

const isReleasable = (value: unknown): value is ReleasableState => (RELEASABLE_STATES as readonly unknown[]).includes(value);

const settledChoice = (value: unknown): { settled?: "archive" | "release" } => (value === "archive" || value === "release" ? { settled: value } : {});

/** `checkoutsChanged` runs after anything that moves checkouts on disk, so the storage figures re-measure. */
export function worktreesRoutes(store: EngineStore, checkoutsChanged: () => void): Route[] {
  const rootAnswer = async () => {
    const state = await probeWorktreesRoot(store.paths.root);
    const blocker = worktreesRootBlocker(state);
    const root = rootOf(state);
    const rotational = root && !blocker ? await onRotationalDisk(root) : undefined;
    return ok({ worktreesRoot: { ...state, default: defaultWorktreesRoot(store.paths.root), ...(blocker ? { blocker } : {}), ...(rotational ? { rotational: true } : {}) } });
  };
  return [
    { method: "GET", path: "/v2/worktrees-root", auth: "engine", handle: rootAnswer },
    {
      method: "PUT",
      path: "/v2/worktrees-root",
      auth: "engine",
      // Takes effect on the next cut; nothing already cut moves.
      handle({ body }) {
        const root = typeof body.root === "string" ? body.root.trim() : undefined;
        if (body.root === null) clearWorktreesRoot(store.paths.root);
        else if (root) {
          if (!path.isAbsolute(root)) throw new HttpError(400, "invalid_request", "a worktrees root must be an absolute path");
          try {
            writeWorktreesRoot(store.paths.root, root);
          } catch (cause) {
            throw new HttpError(400, "invalid_request", cause instanceof Error ? cause.message : "that folder could not be used for session checkouts");
          }
        } else throw new HttpError(400, "invalid_request", "a worktrees root must be an absolute path, or null for the default");
        store.worktrees.forgetSummary();
        checkoutsChanged();
        return rootAnswer();
      },
    },
    {
      method: "POST",
      path: "/v2/worktrees-root/move",
      auth: "engine",
      async handle({ body }) {
        if (typeof body.from !== "string" || !path.isAbsolute(body.from)) throw new HttpError(400, "invalid_request", "from must be the absolute folder to move worktrees out of");
        const state = await probeWorktreesRoot(store.paths.root);
        const destination = rootOf(state);
        if (!destination) throw new HttpError(409, "conflict", worktreesRootBlocker(state) ?? "Telar does not know where session checkouts belong.");
        if (path.resolve(body.from) === path.resolve(destination)) throw new HttpError(409, "conflict", "those worktrees are already at the current location");
        let outcome;
        try {
          outcome = await store.worktrees.move(destination, body.from);
        } catch (cause) {
          throw new HttpError(409, "conflict", cause instanceof Error ? cause.message : "the checkouts could not be moved");
        }
        checkoutsChanged();
        return ok({ move: { ...outcome, summary: describeOutcome(outcome) } });
      },
    },
    // Never cached: every verdict here is acted on, and each can change by the second.
    { method: "GET", path: "/v2/worktrees", auth: "engine", handle: async () => ok({ inventory: await store.worktrees.inventory() }) },
    {
      method: "GET",
      path: "/v2/worktrees/summary",
      auth: "engine",
      handle: async ({ query }) => ok({ summary: await store.worktrees.summary({ refresh: query.get("refresh") === "1" }) }),
    },
    {
      method: "POST",
      path: "/v2/worktrees/reclaim",
      auth: "engine",
      // Archives the sessions that held them; a partial outcome is still a 200 with the refusals in it.
      async handle({ body }) {
        if (isReleasable(body.state)) {
          const results = await store.worktrees.releaseState(body.state);
          checkoutsChanged();
          return ok({ reclaim: { results, summary: describeReclaim(results) } });
        }
        if (!Array.isArray(body.items)) throw new HttpError(400, "invalid_request", "items must be an array of checkouts to give back");
        const items = body.items.map((entry) => {
          const item = entry as { path?: unknown; confirm?: unknown; settled?: unknown };
          if (typeof item.path !== "string" || !item.path.trim()) throw new HttpError(400, "invalid_request", "each item needs the checkout's path");
          return { path: item.path, ...(typeof item.confirm === "string" ? { confirm: item.confirm } : {}), ...settledChoice(item.settled) };
        });
        const results = await store.worktrees.reclaim(items);
        checkoutsChanged();
        return ok({ reclaim: { results, summary: describeReclaim(results) } });
      },
    },
    {
      method: "POST",
      path: /^\/v2\/sessions\/([^/]+)\/worktree\/(release|restore)$/,
      auth: "engine",
      async handle({ params: [sessionId, verb] }) {
        if (verb === "restore") return ok({ session: store.worktrees.restore(sessionId!) });
        const released = await store.worktrees.release(sessionId!, "manual");
        if (!released.ok) throw new HttpError(409, "conflict", `the checkout was not released: ${released.refusal}${released.detail ? ` (${released.detail})` : ""}`);
        return ok({ session: store.records.get(sessionId!) });
      },
    },
  ];
}

import { z } from "zod";
import type { SessionDiff } from "@telar/engine-client";
import { err, failure, fillWithin, json, type ToolFactory } from "../../agent-tools";
import { DIFF_COMMITS_CHARS, DIFF_COMMITS_LIMIT, DIFF_FILES_CHARS, DIFF_FILES_LIMIT, endedNote, type SessionsCapability, SETTLE, STOP } from "./shared";

export function controlTools(tool: ToolFactory, capability: SessionsCapability): unknown[] {
  return [
    tool(
      "sessions_stop",
      STOP,
      { sessionId: z.string().min(1) },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        try {
          const { stopped, live } = await capability.stop(sessionId);
          const settled = stopped.length;
          const behind = live ? settled - 1 : settled;
          return json({
            sessionId,
            stopped: settled,
            ...(live ? { runId: live.runId, state: live.state } : {}),
            note:
              settled === 0
                ? "Nothing was running and nothing was waiting; the session was already idle."
                : `${live ? "The turn is stopped" : "Nothing was running"}${behind > 0 ? ` and ${behind} waiting message${behind === 1 ? "" : "s"} ${behind === 1 ? "was" : "were"} settled rather than started` : ""}. Whatever it had already written is still there — stopping ends work, it never undoes it, and a command it had already run may have finished. The session is IDLE now, not paused: the next message runs normally.`,
          });
        } catch (error) {
          return err(`Could not stop "${sessionId}": ${failure(error)}`);
        }
      },
    ),
    tool(
      "sessions_settle",
      SETTLE,
      {
        sessionId: z.string().min(1),
        settled: z.boolean().optional().describe("Default true."),
      },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        const settled = args.settled !== false;
        try {
          const session = await capability.settle(sessionId, settled);
          return json({
            sessionId,
            settled,
            title: session.title,
            ...(session.ended ? { ended: session.ended } : {}),
            note: settled
              ? `Settled. It is out of the active list but still live: a message to it, or a wake it receives, brings it back. Nothing was archived.${endedNote(session.ended)}`
              : "Back in the active list.",
          });
        } catch (error) {
          return err(`Could not settle "${sessionId}": ${failure(error)}`);
        }
      },
    ),
  ];
}

export async function diffView(capability: SessionsCapability, sessionId: string) {
  let diff: SessionDiff;
  try {
    diff = await capability.diff(sessionId);
  } catch (error) {
    return err(`Could not read the diff for "${sessionId}": ${failure(error)}`);
  }
  if (!diff.repository) {
    return json({
      sessionId,
      note: "That session's checkout is not a git repository, so there is no diff to read. That is a supported configuration, not a fault.",
    });
  }
  const unknown: string[] = [];
  if (diff.filesIncomplete) {
    unknown.push(
      diff.filesIncomplete === "timeout"
        ? "git DID NOT ANSWER IN TIME for the file list, so the files below may be missing rows and the line counts may under-count"
        : "git COULD NOT READ the file list, so the files below may be missing rows and the line counts may under-count",
    );
  }
  if (diff.commitsIncomplete) {
    unknown.push(
      diff.commitsIncomplete === "timeout"
        ? "git DID NOT ANSWER IN TIME for the commit list, so this session may have committed work that is not listed"
        : "git COULD NOT READ the commit list, so this session may have committed work that is not listed",
    );
  }
  if (diff.baseUnverified) {
    unknown.push(
      "git did not confirm the base below; it is the one the session recorded when its checkout was cut, but nothing corroborated it",
    );
  }
  const askAgain = diff.filesIncomplete === "timeout" || diff.commitsIncomplete === "timeout" || diff.baseUnverified === "timeout";
  const nothingListed = diff.files.length === 0 && diff.commits.length === 0;
  return json({
    sessionId,
    ...(diff.branch ? { branch: diff.branch } : {}),
    ...(diff.base ? { base: diff.base } : { baseUnknown: true }),
    ...(diff.baseUnverified ? { baseUnverified: diff.baseUnverified } : {}),
    ...(diff.filesIncomplete ? { filesIncomplete: diff.filesIncomplete } : {}),
    ...(diff.commitsIncomplete ? { commitsIncomplete: diff.commitsIncomplete } : {}),
    ...(askAgain ? { askAgain: true } : {}),
    linesAdded: diff.linesAdded,
    linesRemoved: diff.linesRemoved,
    ...(() => {
      const commits = fillWithin(diff.commits, (commit) => ({ sha: commit.shortSha, subject: commit.subject }), {
        limit: DIFF_COMMITS_LIMIT,
        chars: DIFF_COMMITS_CHARS,
      });
      const files = fillWithin(
        diff.files,
        (file) => ({
          path: file.path,
          status: file.status,
          ...(file.renamedFrom ? { renamedFrom: file.renamedFrom } : {}),
          ...(file.linesAdded === undefined ? {} : { linesAdded: file.linesAdded }),
          ...(file.linesRemoved === undefined ? {} : { linesRemoved: file.linesRemoved }),
          ...(file.binary ? { binary: true } : {}),
        }),
        { limit: DIFF_FILES_LIMIT, chars: DIFF_FILES_CHARS },
      );
      return {
        commitCount: diff.commits.length,
        commits: commits.rows,
        ...(diff.commits.length > commits.rows.length ? { commitsNotShown: diff.commits.length - commits.rows.length } : {}),
        fileCount: diff.files.length,
        files: files.rows,
        ...(diff.files.length > files.rows.length ? { filesNotShown: diff.files.length - files.rows.length } : {}),
      };
    })(),
    ...(diff.truncated ? { truncated: true } : {}),
    note: [
      ...(unknown.length > 0 ? [`${unknown.join(". ")}.`] : []),
      ...(!diff.base ? ["This session has no recorded base, so the diff is against HEAD and any work it has already COMMITTED is not in this list."] : []),
      unknown.length > 0
        ?
          nothingListed
            ? "NOTHING IS LISTED, AND THAT IS NOT THE SAME AS NOTHING CHANGED — do not report this session as having changed nothing."
            : "What is listed is real; what is missing is unknown, so do not report this as the whole of what changed."
        : nothingListed && diff.base
          ? "This session has changed nothing in its checkout."
          : "A read of what changed, and nothing more. Nothing here merges, lands or approves any of it — that is the user's decision, and it is made elsewhere.",
      ...(askAgain ? ["A timeout usually clears: read it again before drawing a conclusion."] : []),
    ].join(" "),
  });
}

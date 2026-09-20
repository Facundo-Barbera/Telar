/**
 * THE WIRE ENCODING OF A DIFF READ — and why it is a builder AND a parser, in
 * one file, in the contract.
 *
 * THIS IS `forgeQuery`'S LESSON, PAID FOR A SECOND TIME. That function carries
 * the note: *"the cockpit built this query correctly, the engine parsed it
 * correctly, and the Next adapter in between forwarded only `refresh` — so
 * choosing a milestone typechecked, passed every test, made a request with the
 * milestone in it, and returned every issue in the repository."*
 *
 * #694 shipped exactly that bug one layer over. The Diff's ignore-whitespace
 * toggle built its option correctly, the engine read `?ignoreWhitespace=1`
 * correctly, and the cockpit's own adapter — `apps/web/lib/engine/client.ts`,
 * hand-written beside the contract's copy — forwarded only `untracked`. The
 * toggle flipped, the row re-read, git was never told, and the same hunks came
 * back. Nothing failed: TypeScript does not check excess properties on a
 * non-literal, so the extra field was dropped in silence.
 *
 * SO THE THREE LAYERS SHARE ONE PAIR. A builder in the contract and a parser
 * hand-written in each of two proxies drift on the first option anybody adds;
 * a builder and a parser in one file cannot.
 */

/**
 * WHAT TO COMPARE AGAINST — the scope selector's half of the request (#694).
 *
 * THREE STATES, AND THE THIRD IS THE POINT:
 *
 *   - absent  the session's own recorded base. What every caller meant before
 *             the selector existed, and still gets without asking.
 *   - a ref   that ref. The "branch" scope.
 *   - `null`  NO base: the working tree. The new default, and a real question
 *             rather than a missing answer — a shared checkout's uncommitted
 *             state is not the session's work, and the surface stops saying it
 *             is.
 *
 * `null` RATHER THAN A SENTINEL STRING, because every sentinel is a ref
 * somebody can name. `HEAD` would be indistinguishable from a reader who chose
 * HEAD deliberately.
 */
export type DiffBaseOption = {
  base?: string | null;
};

export type FilePatchOptions = DiffBaseOption & {
  /** Untracked files are in no diff at all, so they are diffed against
   *  `/dev/null` — see the engine's `sessionFilePatch`. */
  untracked?: boolean;
  /** Re-indentation and inserted blank lines are not changes worth reading.
   *  Applied by GIT, not by the renderer: a hunk that exists only because a
   *  line moved is a hunk before any of it reaches a client. */
  ignoreWhitespace?: boolean;
};

/**
 * `?base=` ABSENT AND `?base=` EMPTY ARE DIFFERENT REQUESTS, which is why this
 * sets the key for `null` instead of skipping it. A layer that dropped the
 * empty one would silently ask for the session's base and get an answer that
 * looks entirely plausible and is about something else.
 */
function appendBase(query: URLSearchParams, options: DiffBaseOption): URLSearchParams {
  if (options.base !== undefined) query.set("base", options.base ?? "");
  return query;
}

/** The query for a whole review. Empty when nothing is being overridden, so
 *  the ordinary read is the bare URL it always was. */
export function diffBaseQuery(options: DiffBaseOption): string {
  return appendBase(new URLSearchParams(), options).toString();
}

/** The query for ONE file's patch. Same base handling, because a row's patch
 *  read against a different base from the list above it would put plausible
 *  hunks under counts from another comparison. */
export function filePatchQuery(path: string, options: FilePatchOptions): string {
  const query = new URLSearchParams({ path });
  if (options.untracked) query.set("untracked", "1");
  if (options.ignoreWhitespace) query.set("ignoreWhitespace", "1");
  return appendBase(query, options).toString();
}

/**
 * The other half — what a server makes of that query.
 *
 * `has` RATHER THAN `get` FOR THE BASE, because absent and present-and-empty
 * are the two different requests this whole module exists to keep apart.
 */
export function parseDiffBaseQuery(params: URLSearchParams): DiffBaseOption {
  if (!params.has("base")) return {};
  const base = params.get("base")?.trim() ?? "";
  return { base: base === "" ? null : base };
}

/** The file-patch half, including the base. `path` is NOT read here: it selects
 *  which file rather than how to compare it, and every caller already has it
 *  from its own route. */
export function parseFilePatchQuery(params: URLSearchParams): FilePatchOptions {
  return {
    untracked: params.get("untracked") === "1",
    ignoreWhitespace: params.get("ignoreWhitespace") === "1",
    ...parseDiffBaseQuery(params),
  };
}

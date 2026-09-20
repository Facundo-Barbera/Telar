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
  /**
   * THE RIGHT-HAND SIDE, WHEN THERE IS ONE — issue #741.
   *
   * Every comparison this contract could express until now was one ref against
   * the WORKING TREE: `git diff <base> --`. A turn is a RANGE — where the
   * repository stood when it started, and where it stood when it ended — and
   * there was no way to say the second half.
   *
   * ABSENT IS THE WORKING TREE, which is what every existing caller means and
   * still gets. Present is `git diff <base> <to>`, a comparison of two commits
   * that nothing on the disk can change.
   *
   * ── AND IT SUPPRESSES THE UNTRACKED READ, which is not a detail ──
   *
   * An untracked file is in no commit, so it is in no commit-to-commit
   * comparison either. The review's file list is three reads and one of them is
   * `status --porcelain -uall`; carrying it into a range would put working-tree
   * rows — files nobody has committed, possibly written after the turn ended —
   * under a heading that says "what this turn did". That is #690's defect
   * arriving by a third door, so the engine drops that read when `to` is set
   * rather than leaving it to each caller to remember.
   *
   * NO `null` STATE, unlike `base`. "Compare against the working tree" is what
   * absent already means, so a second spelling of it would be the ambiguity
   * `base` needs three states to avoid, invented where it is not needed.
   */
  to?: string;
};

export type FilePatchOptions = DiffBaseOption & {
  /** Untracked files are in no diff at all, so they are diffed against
   *  `/dev/null` — see the engine's `sessionFilePatch`. */
  untracked?: boolean;
  /** Re-indentation and inserted blank lines are not changes worth reading.
   *  Applied by GIT, not by the renderer: a hunk that exists only because a
   *  line moved is a hunk before any of it reaches a client. */
  ignoreWhitespace?: boolean;
  /**
   * WHERE THE FILE CAME FROM, WHEN IT CAME FROM SOMEWHERE — issue #694, §2.2.
   *
   * A RENAME IS A FACT ABOUT TWO PATHS, and a patch read with one of them
   * cannot express it: `git diff HEAD -- <newpath>` excludes the old path from
   * the pathspec, so rename detection has nothing to pair, and git answers
   * `new file mode 100644` with the whole file as additions. The row said
   * "Renamed from src.txt, ±0" and the patch under it said the file was brand
   * new — two contradictory claims inside one row.
   *
   * SO IT IS PART OF THE REQUEST rather than something the engine could look
   * up: the LIST already knows it (`GitFileChange.renamedFrom`, from
   * `--find-renames`), and the patch read is a separate command that would
   * otherwise have to re-derive it from a second full diff.
   *
   * ...AND IT IS DEFINED HERE, which is the point of this module: #739 made
   * this file the one place a diff parameter may be declared, precisely so the
   * next option added could not reach two layers and stop.
   */
  renamedFrom?: string;
};

/**
 * `?base=` ABSENT AND `?base=` EMPTY ARE DIFFERENT REQUESTS, which is why this
 * sets the key for `null` instead of skipping it. A layer that dropped the
 * empty one would silently ask for the session's base and get an answer that
 * looks entirely plausible and is about something else.
 */
function appendBase(query: URLSearchParams, options: DiffBaseOption): URLSearchParams {
  if (options.base !== undefined) query.set("base", options.base ?? "");
  // `to` HAS NO EMPTY STATE to preserve — absent already means the working
  // tree — so a blank one is simply not sent rather than becoming a third
  // meaning nobody declared.
  if (options.to) query.set("to", options.to);
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
  if (options.renamedFrom) query.set("renamedFrom", options.renamedFrom);
  return appendBase(query, options).toString();
}

/**
 * The other half — what a server makes of that query.
 *
 * `has` RATHER THAN `get` FOR THE BASE, because absent and present-and-empty
 * are the two different requests this whole module exists to keep apart.
 */
export function parseDiffBaseQuery(params: URLSearchParams): DiffBaseOption {
  // `to` IS READ WHETHER OR NOT THERE IS A BASE, because the two are
  // independent halves of one comparison: `?to=<sha>` alone is "the session's
  // own base, up to that commit", which is a request somebody can make.
  const raw = params.get("to")?.trim();
  const to = raw ? { to: raw } : {};
  if (!params.has("base")) return to;
  const base = params.get("base")?.trim() ?? "";
  return { ...to, base: base === "" ? null : base };
}

/** The file-patch half, including the base. `path` is NOT read here: it selects
 *  which file rather than how to compare it, and every caller already has it
 *  from its own route. */
export function parseFilePatchQuery(params: URLSearchParams): FilePatchOptions {
  // An EMPTY `renamedFrom` is no rename rather than a rename from the
  // repository root, which is what a bare `?renamedFrom=` would otherwise mean
  // to a pathspec.
  const renamedFrom = params.get("renamedFrom")?.trim();
  return {
    untracked: params.get("untracked") === "1",
    ignoreWhitespace: params.get("ignoreWhitespace") === "1",
    ...(renamedFrom ? { renamedFrom } : {}),
    ...parseDiffBaseQuery(params),
  };
}

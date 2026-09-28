export type DiffBaseOption = {
  base?: string | null;
  to?: string;
};

export type FilePatchOptions = DiffBaseOption & {
  /** Untracked files are in no diff at all, so they are diffed against
   *  `/dev/null` — see the engine's `sessionFilePatch`. */
  untracked?: boolean;
  ignoreWhitespace?: boolean;
  renamedFrom?: string;
};

function appendBase(query: URLSearchParams, options: DiffBaseOption): URLSearchParams {
  if (options.base !== undefined) query.set("base", options.base ?? "");
  if (options.to) query.set("to", options.to);
  return query;
}

export function diffBaseQuery(options: DiffBaseOption): string {
  return appendBase(new URLSearchParams(), options).toString();
}

export function filePatchQuery(path: string, options: FilePatchOptions): string {
  const query = new URLSearchParams({ path });
  if (options.untracked) query.set("untracked", "1");
  if (options.ignoreWhitespace) query.set("ignoreWhitespace", "1");
  if (options.renamedFrom) query.set("renamedFrom", options.renamedFrom);
  return appendBase(query, options).toString();
}

export function parseDiffBaseQuery(params: URLSearchParams): DiffBaseOption {
  const raw = params.get("to")?.trim();
  const to = raw ? { to: raw } : {};
  if (!params.has("base")) return to;
  const base = params.get("base")?.trim() ?? "";
  return { ...to, base: base === "" ? null : base };
}

export function parseFilePatchQuery(params: URLSearchParams): FilePatchOptions {
  const renamedFrom = params.get("renamedFrom")?.trim();
  return {
    untracked: params.get("untracked") === "1",
    ignoreWhitespace: params.get("ignoreWhitespace") === "1",
    ...(renamedFrom ? { renamedFrom } : {}),
    ...parseDiffBaseQuery(params),
  };
}

import { isDirectoryFailure, listDirectories, type DirectoryDeps } from "../fs-dirs";

export type RouteAnswer = { status: number; body: unknown };

export const fsRoute = {
  method: "GET",
  path: "/v2/fs",
  auth: "engine",
  handle(url: URL, deps: DirectoryDeps = {}): RouteAnswer {
    const query = url.searchParams;
    const listed = listDirectories({
      path: query.get("path"),
      hidden: query.get("hidden") === "1",
      nearest: query.get("nearest") === "1",
    }, deps);
    if (isDirectoryFailure(listed)) return { status: listed.code === "not_found" ? 404 : 400, body: { error: listed } };
    return { status: 200, body: listed };
  },
} as const;

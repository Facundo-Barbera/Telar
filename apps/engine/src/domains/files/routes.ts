import type { Route } from "../../platform/http/route";
import { isDirectoryFailure, listDirectories, type DirectoryDeps } from "./directories";

export function filesRoutes(deps: DirectoryDeps = {}): Route[] {
  return [
    {
      method: "GET",
      path: "/v2/fs",
      auth: "engine",
      handle({ query }) {
        const listed = listDirectories(
          { path: query.get("path"), hidden: query.get("hidden") === "1", nearest: query.get("nearest") === "1" },
          deps,
        );
        if (isDirectoryFailure(listed)) {
          const { unreadable, ...error } = listed;
          return { status: listed.code === "not_found" ? 404 : unreadable ? 403 : 400, body: { error } };
        }
        return { status: 200, body: listed };
      },
    },
  ];
}

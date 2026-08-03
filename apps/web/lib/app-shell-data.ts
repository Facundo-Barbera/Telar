import { cache } from "react";
import { listLooms } from "@telar/core/looms";
import { listProjects } from "@telar/core/manifest";
import { readAccountsEnvelope } from "@/lib/accounts-server";
import { listChats } from "@/lib/store";

// Root layouts and pages are rendered as one server request, but they are
// separate components. These request-memoized readers keep both from scanning
// the same local files independently during the app's cold entry render.
export const readAppShellAccounts = cache(() => readAccountsEnvelope());

export const listAppShellProjects = cache(() =>
  listProjects().filter((project) => project.manifest !== null),
);

export const listAppShellChats = cache(() =>
  listChats(undefined, { archived: "include" }).filter(
    (chat) => chat.role !== "steerer" && chat.role !== "escalation" && Boolean(chat.project),
  ),
);

export const listAppShellLooms = cache(() =>
  listLooms().filter((loom) => !loom.draft && !loom.parentLoomId),
);

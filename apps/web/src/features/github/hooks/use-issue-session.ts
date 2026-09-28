import { useCallback, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { GitHubIssue, GitOverview } from "@telar/engine-client";
import { readDraft, writeDraft } from "@/features/composer";
import { insertReference } from "@/lib/drag-reference";
import { createEngineApi, EngineApiError } from "@/lib/engine/client";
import { canvasHref } from "@/lib/session-list";
import { issueSessionStart } from "../model";

const api = createEngineApi();

/** Issue → session: read the checkout on the press, then refuse with a reason or open an armed canvas. */
export function useIssueSession({
  projectId,
  hostId,
  onInsertReference,
}: {
  projectId?: string;
  hostId?: string;
  onInsertReference?: (text: string) => void;
}) {
  const [refusal, setRefusal] = useState<string>();
  const [starting, setStarting] = useState<number>();
  const router = useRouter();
  const pathname = usePathname();

  const start = useCallback(
    async (issue: GitHubIssue) => {
      if (!projectId) return;
      setRefusal(undefined);
      setStarting(issue.number);
      let git: GitOverview | undefined;
      let unreadable: string | undefined;
      try {
        git = (await api.projectGit(projectId)).git;
      } catch (cause) {
        unreadable = cause instanceof EngineApiError ? cause.message : undefined;
      } finally {
        setStarting(undefined);
      }
      const result = issueSessionStart({
        issue,
        projectId,
        ...(hostId ? { hostId } : {}),
        ...(git ? { git } : {}),
        ...(unreadable ? { unreadable } : {}),
      });
      if (!result.ok) {
        setRefusal(result.reason);
        return;
      }
      // A canvas already open here owns its draft key and would overwrite a write underneath it.
      if (onInsertReference && pathname === canvasHref(projectId, hostId)) onInsertReference(result.text);
      else {
        const existing = readDraft(undefined, projectId);
        writeDraft(undefined, projectId, existing.trim() ? insertReference(existing, result.text, existing.length).draft : result.text);
      }
      router.push(result.href);
    },
    [projectId, hostId, onInsertReference, pathname, router],
  );

  return { refusal, starting, start };
}
